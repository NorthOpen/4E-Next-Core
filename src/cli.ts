import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DB_FILE } from "./lib/paths.ts";
import { verifyDatabase } from "./db/verify.ts";
import { openDb } from "./api/index.ts";

/**
 * 命令行入口。
 *
 * 两类命令，依赖要求不同 —— 这是刻意的：
 *
 *   查询类（query / verify / profile / status / json）
 *       只用 Node 内置模块 + 数据库文件，**零依赖**，克隆下来就能跑。
 *
 *   构建类（extract / classify / normalize / gear / rules / monsters / db / sync / all / rebuild）
 *       需要 `npm install`（zod 用于规范层校验）。这些命令用动态 import 加载，
 *       所以不装依赖也不影响任何查询。
 *
 * 阶段与产物：
 *   extract   → out/raw/tiddlers-raw.jsonl           无损层
 *   classify  → out/categories/_classification.json  归类依据
 *   normalize → out/canonical/*.jsonl                规范层 + 溯源哈希
 *   gear      → out/canonical/gear.jsonl             从参考页表格派生
 *   rules     → out/rules/rules.json                 万律
 *   monsters  → out/monsters/**                      怪物手册
 *   db        → ./4e-next-core.db                    ← 交付物
 *   json      → out/json/**                          浏览器用（从数据库导出）
 */

const pct = (v: number): string => (v * 100).toFixed(1) + "%";
const ms = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + "s" : n + "ms");

/** 构建类命令统一从这里拿 ETL，避免查询类命令被迫依赖 zod。 */
async function etl() {
  const [
    { runExtract },
    { runClassify },
    { runNormalize },
    { runGear },
    { findRulesSource, runRules },
    { runMonsters },
    { findMonsterSource },
    { findWikiSource },
    { buildDatabase },
    { runSync },
  ] = await Promise.all([
    import("./etl/extract.ts"),
    import("./etl/classify.ts"),
    import("./etl/normalize.ts"),
    import("./etl/gear.ts"),
    import("./etl/rules.ts"),
    import("./etl/monsters/index.ts"),
    import("./etl/monsters/extract.ts"),
    import("./etl/sources.ts"),
    import("./db/build.ts"),
    import("./etl/sync.ts"),
  ]);
  return {
    runExtract,
    runClassify,
    runNormalize,
    runGear,
    findRulesSource,
    runRules,
    runMonsters,
    findMonsterSource,
    findWikiSource,
    buildDatabase,
    runSync,
  };
}

function missingDependency(): void {
  console.error("[!] 构建类命令需要两个前提：");
  console.error("    1) `npm install`（zod 用于规范层校验）；");
  console.error("    2) data/ 里有源文件（4e Wiki.htm / 4e Rules Compendium.htm / 怪物手册 xlsx）。");
  console.error("    只做数据接入不需要它们：query / verify / profile / status 零依赖即可运行。");
  process.exitCode = 1;
}

async function cmdExtract(): Promise<void> {
  const { runExtract, findWikiSource } = await etl();
  const src = findWikiSource();
  if (!src) {
    console.error("[extract] 未找到 4e Wiki 源文件：把文件名含 wiki / 维基 的 HTML 放进 data/");
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  const sum = runExtract(src);
  console.log(`[extract] ${sum.total} 个 tiddler（系统 ${sum.system} / 内容 ${sum.content}），${ms(Date.now() - t0)}`);
  console.log(`[extract] → ${sum.rawFile}`);
}

async function cmdClassify(): Promise<void> {
  const { runClassify } = await etl();
  const t0 = Date.now();
  const counts = runClassify();
  console.log(`[classify] ${Object.keys(counts).length} 个类别，${ms(Date.now() - t0)}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
}

async function cmdNormalize(): Promise<void> {
  const { runNormalize } = await etl();
  const t0 = Date.now();
  const counts = runNormalize();
  console.log(`[normalize] ${Object.values(counts).reduce((a, b) => a + b, 0)} 条，${ms(Date.now() - t0)}`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
}

async function cmdGear(): Promise<void> {
  const { runGear } = await etl();
  const t0 = Date.now();
  const r = runGear();
  console.log(`[gear] 冒险装备 ${r.total} 条（工具包 ${r.kits} 个），${ms(Date.now() - t0)}`);
  for (const [g, n] of Object.entries(r.groups).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${g}`);
  if (r.duplicates.length) console.warn(`[gear] 重名跳过 ${r.duplicates.length} 条: ${r.duplicates.join(" / ")}`);
  if (r.invalid.length) {
    for (const e of r.invalid) console.error(`[gear] 校验失败 ${e}`);
    process.exitCode = 1;
  }
}

async function cmdRules(): Promise<void> {
  const { findRulesSource, runRules } = await etl();
  if (!findRulesSource()) {
    console.warn("[rules] 未找到万律源文件（文件名含 rule / 万律的单文件 TW5 HTML），跳过");
    return;
  }
  const t0 = Date.now();
  const r = runRules();
  console.log(`[rules] ${r.total} 条（章节 ${r.chapters} / 术语 ${r.terms} / 问答 ${r.faq}），${ms(Date.now() - t0)}`);
  console.log(`[rules] → ${r.output}`);
}

async function cmdMonsters(): Promise<void> {
  const { runMonsters, findMonsterSource } = await etl();
  const src = findMonsterSource();
  if (!src) {
    console.warn("[monsters] 未找到怪物手册 xlsx，跳过");
    return;
  }
  const t0 = Date.now();
  const r = runMonsters({ source: src });
  const c = r.coverage;
  console.log(`[monsters] 无损层 ${r.raw.rows} 行 / 目录 ${r.raw.tocEntries} 章 / 图片锚点 ${r.raw.images}`);
  console.log(`[monsters] 分块 ${r.blocks.sections} 章 → ${r.blocks.blocks} 个怪物块`);
  console.log(`[monsters] 规范层 ${r.total} 条（校验通过 ${r.valid} / 失败 ${r.invalid}），${ms(Date.now() - t0)}`);
  console.log(
    `[monsters] 书归属 ${Object.entries(r.byBook).map(([k, v]) => `${k}=${v}`).join(" ")}（未对齐目录 ${c.sections.unmatched.length} 章）`,
  );
  console.log(
    `[monsters] 覆盖率 等级 ${pct(c.fieldCoverage.level)} / HP ${pct(c.fieldCoverage.hp)} / AC ${pct(c.fieldCoverage.ac)} / 威能 ${pct(c.fieldCoverage.powers)}`,
  );
  console.log(`[monsters] 威能 ${c.powers.totalPowers} 条 + 特性 ${c.powers.totalTraits} 条`);
}

async function cmdDb(): Promise<void> {
  const { buildDatabase } = await etl();
  let r: ReturnType<typeof buildDatabase>;
  try {
    r = buildDatabase();
  } catch (err) {
    // 缺规范层是「输入没准备好」，不是程序坏了：只打消息，不打栈
    console.error(`[db] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const c = r.changes;
  console.log(
    `[db] ${r.entries} 条词条，关系边 ${r.relations} 条，链接解析 ${r.resolvedLinks} 命中 / ${r.unresolvedLinks} 未命中`,
  );
  console.log(
    `[db] ${c.initial ? "首次导入" : "增量同步"} 新增 ${c.added.length} / 更新 ${c.changed.length} / 移除 ${c.removed.length} / 未变 ${c.unchanged}`,
  );
  console.log(`[db] 体积 ${(r.bytes / 1048576).toFixed(1)} MB，耗时 ${ms(r.durationMs)}`);
  console.log(`[db] → ${r.file}`);
}

async function cmdSync(args: string[]): Promise<void> {
  const { runSync } = await etl();
  const force = args.includes("--force") || args.includes("-f");
  const exportAlways = args.includes("--export") || force;
  const t0 = Date.now();
  const r = runSync({ force, exportAlways });

  console.log("[sync] 来源指纹");
  for (const s of r.sources) {
    const mark = s.changed ? "变了" : s.exists ? "未变" : "缺失";
    console.log(`  ${mark}  ${s.label.padEnd(6)} ${s.reason}${s.changed ? `（${s.currentSha.slice(0, 8)}）` : ""}`);
  }
  console.log(`[sync] 跑过 ${r.ran.length ? r.ran.join(" → ") : "（无）"}`);
  for (const s of r.skipped) console.log(`  skip  ${s.stage}：${s.reason}`);
  console.log(
    `[sync] ${r.initial ? "首次导入" : "增量同步"}：新增 ${r.changes.added} / 更新 ${r.changes.changed} / 移除 ${r.changes.removed} / 未变 ${r.changes.unchanged}`,
  );
  console.log(`[sync] 总耗时 ${ms(Date.now() - t0)}`);

  // 「什么都没跑」有两种原因，必须分开说，否则缺源文件会被误报成「数据没有变化」
  const missing = r.sources.filter((s) => !s.exists);
  if (r.ran.length === 0 && missing.length > 0) {
    console.warn(`[sync] 未重建：${missing.map((s) => s.label).join(" / ")} 源文件缺失，数据库保持原样。`);
    console.warn("    把源文件放进 data/ 后重试（文件名特征见 README 第 7 节）。");
    process.exitCode = 1;
    return;
  }
  if (!r.databaseChanged) console.log("[sync] 数据没有变化");
}

async function cmdJson(): Promise<void> {
  const { exportJson } = await import("./export/json.ts");
  const t0 = Date.now();
  const r = exportJson();
  console.log(`[json] ${r.files} 个文件，${(r.bytes / 1048576).toFixed(1)} MB，${ms(Date.now() - t0)}`);
  console.log(`[json] → ${r.dir}`);
}

async function cmdVerify(): Promise<void> {
  const r = verifyDatabase();
  for (const c of r.checks) {
    const mark = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
    console.log(`  ${mark}  ${c.name.padEnd(18)} ${c.detail}`);
  }
  console.log(`[verify] ${r.pass} 通过 / ${r.warn} 警告 / ${r.fail} 失败`);
  if (!r.ok) process.exitCode = 1;
}

async function cmdProfile(): Promise<void> {
  const db = openDb();
  try {
    console.log("[profile] 类别分布");
    for (const c of db.categories()) console.log(`  ${String(c.entries).padStart(6)}  ${c.category}`);

    console.log("[profile] 主要书籍（前 12）");
    for (const b of db.books().slice(0, 12)) console.log(`  ${String(b.entries).padStart(6)}  ${b.code}  ${b.title ?? ""}`);

    console.log("[profile] 威能频率");
    for (const u of db.sql<{ usage: string | null; n: number }>(
      "SELECT usage, COUNT(*) AS n FROM power GROUP BY usage ORDER BY n DESC",
    )) {
      console.log(`  ${String(u.n).padStart(6)}  ${u.usage ?? "(未填)"}`);
    }

    console.log("[profile] 关系边");
    for (const r of db.sql<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM relation GROUP BY kind ORDER BY n DESC")) {
      console.log(`  ${String(r.n).padStart(6)}  ${r.kind}`);
    }
  } finally {
    db.close();
  }
}

async function cmdQuery(args: string[]): Promise<void> {
  const [what, ...rest] = args;
  const db = openDb();
  try {
    if (what === "sql") {
      const query = rest.join(" ");
      if (!query) {
        console.error('用法: node src/cli.ts query sql "SELECT ..."');
        process.exitCode = 1;
        return;
      }
      const rows = db.sql(query);
      for (const row of rows) console.log(JSON.stringify(row));
      if (rows.length === 0) console.error("-- 0 行");
      return;
    }
    if (what === "search") {
      for (const r of db.search(rest.join(" "), { limit: 20 })) console.log(`${r.category.padEnd(14)} ${r.name}  —— ${r.uid}`);
      return;
    }
    if (what === "get") {
      console.log(JSON.stringify(db.entry(rest.join(" ")), null, 2));
      return;
    }
    console.error("用法: node src/cli.ts query <sql|search|get> <参数>");
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

async function cmdStatus(): Promise<void> {
  console.log(`  ${existsSync(DB_FILE) ? "有" : "缺"}  数据库    4e-next-core.db`);
  const rawFile = join("out", "raw", "tiddlers-raw.jsonl");
  const canonDir = join("out", "canonical");
  console.log(`  ${existsSync(rawFile) ? "有" : "缺"}  无损层    out/raw/tiddlers-raw.jsonl`);
  const canonFiles = existsSync(canonDir) ? readdirSync(canonDir).filter((f) => f.endsWith(".jsonl")).length : 0;
  console.log(`  ${canonFiles ? "有" : "缺"}  规范层    out/canonical/（${canonFiles} 个类别）`);
  const mf = join("out", "monsters", "canonical", "monster.jsonl");
  if (existsSync(mf)) console.log(`  有  怪物      ${readFileSync(mf, "utf8").split("\n").filter((l) => l.trim()).length} 条`);

  if (!canonFiles) {
    console.log("\n提示：没有规范层时只能查询。要重建数据库，先把三个源文件放回 data/，再 npm install && npm run rebuild。");
  }
  if (existsSync(DB_FILE)) {
    const db = openDb();
    try {
      for (const r of db.sql<{ key: string; value: string }>(
        "SELECT key, value FROM meta WHERE key IN ('schema_version','entries','built_at','relations')",
      )) {
        console.log(`  meta.${r.key} = ${r.value}`);
      }
    } finally {
      db.close();
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const handlers: Record<string, () => Promise<void>> = {
    all: () => cmdSync(["--force"]),
    rebuild: () => cmdSync(["--force"]),
    sync: () => cmdSync(process.argv.slice(3)),
    extract: cmdExtract,
    classify: cmdClassify,
    normalize: cmdNormalize,
    gear: cmdGear,
    rules: cmdRules,
    monsters: cmdMonsters,
    db: cmdDb,
    json: cmdJson,
    verify: cmdVerify,
    profile: cmdProfile,
    status: cmdStatus,
    query: () => cmdQuery(process.argv.slice(3)),
  };
  const h = handlers[cmd];
  if (!h) {
    console.error(`未知命令: ${cmd}`);
    console.error(`用法: node src/cli.ts <${Object.keys(handlers).join("|")}>`);
    process.exitCode = 1;
    return;
  }
  try {
    await h();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Cannot find package 'zod'/.test(message)) {
      missingDependency();
      return;
    }
    throw err;
  }
}

void main();

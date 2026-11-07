import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CANONICAL_DIR, DB_FILE, MONSTERS_CANONICAL_DIR, RULES_DIR } from "../lib/paths.ts";
import { buildFtsQuery } from "../lib/text.ts";

/**
 * 数据库自检。任何一条 FAIL 都意味着「下游拿到的东西不可信」，构建应当视为失败。
 *
 * 分四类：
 *   · 结构完整性：SQLite 自身的 integrity_check / foreign_key_check；
 *   · 数量对账：库里的行数 vs 规范层 JSONL 的行数（防止某一类被静默漏掉）；
 *   · 覆盖质量：关键字段的填充率（掉了说明上游排版变了，抽取规则要跟着改）；
 *   · 检索可用性：每个类别都能用中文子串搜到自己。
 */

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface VerifyReport {
  checks: CheckResult[];
  pass: number;
  warn: number;
  fail: number;
  ok: boolean;
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function readJsonlCount(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
}

export function verifyDatabase(file: string = DB_FILE, opts: { sampleSearch?: number } = {}): VerifyReport {
  const checks: CheckResult[] = [];
  const add = (name: string, status: CheckResult["status"], detail: string): void => {
    checks.push({ name, status, detail });
  };

  if (!existsSync(file)) {
    add("数据库存在", "fail", `找不到 ${file}，先运行 node src/cli.ts db`);
    return { checks, pass: 0, warn: 0, fail: 1, ok: false };
  }

  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    // --- 结构完整性 ---
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const integrityOk = integrity.length === 1 && Object.values(integrity[0])[0] === "ok";
    add("integrity_check", integrityOk ? "pass" : "fail", integrityOk ? "ok" : JSON.stringify(integrity).slice(0, 200));

    const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    add("foreign_key_check", fk.length === 0 ? "pass" : "fail", fk.length === 0 ? "无悬空外键" : `${fk.length} 条悬空外键`);

    // --- 数量对账 ---
    // 规范层在的时候按规范层对账（能抓「某一类被静默漏掉」）；
    // 只拿到数据库时退化为「库内 vs meta」，否则这条检查在分发包里永远 FAIL。
    const entryCount = count(db, "SELECT COUNT(*) AS n FROM entry");
    const canonicalCount =
      readJsonlCountTotal(CANONICAL_DIR) + readJsonlCount(join(MONSTERS_CANONICAL_DIR, "monster.jsonl")) + readJsonlCountRules();
    if (canonicalCount > 0) {
      add(
        "条目数量对账",
        entryCount === canonicalCount ? "pass" : "fail",
        `库内 ${entryCount} / 规范层 ${canonicalCount}`,
      );
    } else {
      const declared = count(db, "SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'entries'");
      add("条目数量对账", entryCount === declared ? "pass" : "fail", `库内 ${entryCount} / meta 记录 ${declared}（无规范层，按元信息对账）`);
    }

    const uidDup = count(db, "SELECT COUNT(*) AS n FROM (SELECT uid FROM entry GROUP BY uid HAVING COUNT(*) > 1)");
    add("uid 唯一", uidDup === 0 ? "pass" : "fail", uidDup === 0 ? "ok" : `${uidDup} 个重复 uid`);

    const ftsCount = count(db, "SELECT COUNT(*) AS n FROM entry_fts");
    add("FTS 行数对账", ftsCount === entryCount ? "pass" : "fail", `entry_fts ${ftsCount} / entry ${entryCount}`);

    // --- 覆盖质量 ---
    const emptyName = count(db, "SELECT COUNT(*) AS n FROM entry WHERE name = '' OR name IS NULL");
    add("名称非空", emptyName === 0 ? "pass" : "fail", emptyName === 0 ? "ok" : `${emptyName} 条名称为空`);

    const bodyEmpty = count(
      db,
      "SELECT COUNT(*) AS n FROM entry e WHERE (e.source_text = '' OR e.source_text IS NULL) AND NOT EXISTS (SELECT 1 FROM entry_field f WHERE f.entry_id = e.id)",
    );
    add("原文非空", bodyEmpty === 0 ? "pass" : "warn", bodyEmpty === 0 ? "ok" : `${bodyEmpty} 条既无原文也无字段`);

    const powerPartCoverage = ratio(db, "SELECT COUNT(DISTINCT entry_id) AS n FROM power_part", "SELECT COUNT(*) AS n FROM power");
    add("威能拆段覆盖", powerPartCoverage >= 0.99 ? "pass" : "warn", `${(powerPartCoverage * 100).toFixed(1)}%`);

    const itemBlockCoverage = ratio(db, "SELECT COUNT(DISTINCT entry_id) AS n FROM item_block", "SELECT COUNT(*) AS n FROM equipment");
    add("物品特性块覆盖", itemBlockCoverage >= 0.9 ? "pass" : "warn", `${(itemBlockCoverage * 100).toFixed(1)}%`);

    const monsterPowerCoverage = ratio(
      db,
      "SELECT COUNT(DISTINCT entry_id) AS n FROM monster_power WHERE kind = 'power'",
      "SELECT COUNT(*) AS n FROM monster",
    );
    add("怪物威能覆盖", monsterPowerCoverage >= 0.9 ? "pass" : "warn", `${(monsterPowerCoverage * 100).toFixed(1)}%`);

    const ruleChapterOrphan = count(db, "SELECT COUNT(*) AS n FROM rule_meta WHERE kind = 'rule' AND chapter_id IS NULL");
    add("万律章节归位", ruleChapterOrphan === 0 ? "pass" : "warn", `${ruleChapterOrphan} 条规则词条没有章节`);

    // --- 检索可用性 ---
    const sample = db
      .prepare("SELECT id, name, category FROM entry WHERE category IN ('power','feat','equipment','monster','rule','race','class') ORDER BY id LIMIT ?")
      .all(opts.sampleSearch ?? 40) as Array<{ id: number; name: string; category: string }>;
    let searched = 0;
    let hit = 0;
    for (const row of sample) {
      // 用名称的一个中文片段搜；2 字以上才有意义
      const chars = Array.from(row.name).filter((c) => /[\u3400-\u9fff]/.test(c));
      if (chars.length < 2) continue;
      const probe = chars.slice(0, Math.min(3, chars.length)).join("");
      const q = buildFtsQuery(probe);
      if (!q) continue;
      searched++;
      const found = db.prepare("SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? LIMIT 1").all(q) as unknown[];
      if (found.length > 0) hit++;
    }
    add(
      "中文子串检索",
      searched === 0 ? "warn" : hit === searched ? "pass" : hit / searched >= 0.95 ? "warn" : "fail",
      `${hit}/${searched} 条抽样命中`,
    );

    // --- 关系图 ---
    const relOrphan = count(
      db,
      "SELECT COUNT(*) AS n FROM relation r LEFT JOIN entry a ON a.id = r.from_entry_id LEFT JOIN entry b ON b.id = r.to_entry_id WHERE a.id IS NULL OR b.id IS NULL",
    );
    add("关系边完整", relOrphan === 0 ? "pass" : "fail", relOrphan === 0 ? "ok" : `${relOrphan} 条边指向不存在的词条`);

    const linkRate = ratio(
      db,
      "SELECT COUNT(*) AS n FROM entry_link WHERE target_entry_id IS NOT NULL",
      "SELECT COUNT(*) AS n FROM entry_link",
    );
    add("wiki 链接解析率", linkRate >= 0.5 ? "pass" : "warn", `${(linkRate * 100).toFixed(1)}%`);
  } finally {
    db.close();
  }

  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  return { checks, pass, warn, fail, ok: fail === 0 };
}

function ratio(db: DatabaseSync, numeratorSql: string, denominatorSql: string): number {
  const num = count(db, numeratorSql);
  const den = count(db, denominatorSql);
  return den === 0 ? 0 : num / den;
}

function readJsonlCountTotal(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readDirSafe(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    n += readJsonlCount(join(dir, f));
  }
  return n;
}

function readJsonlCountRules(): number {
  const file = join(RULES_DIR, "rules.json");
  if (!existsSync(file)) return 0;
  const payload = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown[] };
  return payload.entries?.length ?? 0;
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

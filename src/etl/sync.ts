import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE, CANONICAL_DIR, RULES_DIR, MONSTERS_CANONICAL_DIR } from "../lib/paths.ts";
import { sha256File } from "../lib/hash.ts";
import { findWikiSource } from "./sources.ts";
import { findRulesSource } from "./rules.ts";
import { findMonsterSource } from "./monsters/extract.ts";
import { runExtract } from "./extract.ts";
import { runClassify } from "./classify.ts";
import { runNormalize } from "./normalize.ts";
import { runGear } from "./gear.ts";
import { runRules } from "./rules.ts";
import { runMonsters } from "./monsters/index.ts";
import { buildDatabase } from "../db/build.ts";
import { exportJson } from "../export/json.ts";

/**
 * 增量更新编排。
 *
 * 判断「要不要重跑」的依据是**源文件指纹**：每条来源的 sha256 在建库时记进了
 * `source` 表，这里重新算一遍当前文件的哈希去比。变了才跑对应阶段，
 * 没变就整段跳过（`extract` 要把 24 MB 的单文件 TW5 全量解析一遍，不该白跑）。
 *
 * 注意：`js` 导出（28 s）与大库重建（7 s）是这里最贵的两步，所以在没有变更时都不跑。
 */

export interface SourceCheck {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  /** 建库时记录的指纹（空字符串表示当初也没找到文件） */
  recordedSha: string;
  currentSha: string;
  changed: boolean;
  reason: string;
}

export interface SyncResult {
  sources: SourceCheck[];
  /** 跑过的阶段名 */
  ran: string[];
  /** 跳过的阶段名（附原因） */
  skipped: Array<{ stage: string; reason: string }>;
  databaseChanged: boolean;
  changes: { added: number; changed: number; removed: number; unchanged: number };
  initial: boolean;
  bytes: number;
  durationMs: number;
}

interface RecordedSource {
  key: string;
  path: string;
  sha256: string;
}

function readRecordedSources(dbFile: string): Map<string, RecordedSource> {
  const out = new Map<string, RecordedSource>();
  if (!existsSync(dbFile)) return out;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const has = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='source'").get() as { n: number };
    if (!has.n) return out;
    const rows = db.prepare("SELECT key, path, sha256 FROM source").all() as unknown as RecordedSource[];
    for (const r of rows) out.set(r.key, r);
  } finally {
    db.close();
  }
  return out;
}

function fileSha(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  try {
    return sha256File(path);
  } catch {
    return "";
  }
}

/** 三条来源各自「当前文件 vs 建库时记录」的指纹对比。 */
export function checkSources(dbFile: string = DB_FILE): SourceCheck[] {
  const recorded = readRecordedSources(dbFile);
  const wiki = findWikiSource();
  const rules = findRulesSource();
  const monsters = findMonsterSource();

  const build = (key: string, label: string, path: string | undefined): SourceCheck => {
    const prev = recorded.get(key);
    const currentSha = fileSha(path);
    const recordedSha = prev?.sha256 ?? "";
    const exists = Boolean(path && existsSync(path));
    let changed = currentSha !== recordedSha;
    let reason: string;
    if (!exists) {
      changed = false;
      reason = "源文件未找到（沿用已有产物）";
    } else if (!prev) {
      reason = "库里没有记录，视为新来源";
    } else if (!recordedSha) {
      reason = "建库时源文件缺失，本次补上";
    } else if (changed) {
      reason = "指纹变化";
    } else {
      reason = "指纹一致";
    }
    return { key, label, path: path ?? "", exists, recordedSha, currentSha, changed, reason };
  };

  return [
    build("wiki", "4e Wiki", wiki),
    build("rules", "4e 万律", rules),
    build("monsters", "怪物手册", monsters),
  ];
}

/** 规范层产物是否齐全（缺了就必须重跑对应阶段，哪怕源文件没变）。 */
function stageOutputsPresent(): { wiki: boolean; rules: boolean; monsters: boolean } {
  const hasFile = (p: string): boolean => existsSync(p);
  return {
    wiki: hasFile(CANONICAL_DIR) && hasFile(`${CANONICAL_DIR}/power.jsonl`),
    rules: hasFile(`${RULES_DIR}/rules.json`),
    monsters: hasFile(`${MONSTERS_CANONICAL_DIR}/monster.jsonl`),
  };
}

export interface SyncOptions {
  /** 不看指纹，全部重跑 */
  force?: boolean;
  /** 没有数据变更时也重新导出 JSON 包 */
  exportAlways?: boolean;
  dbFile?: string;
}

export function runSync(opts: SyncOptions = {}): SyncResult {
  const started = Date.now();
  const dbFile = opts.dbFile ?? DB_FILE;
  const sources = checkSources(dbFile);
  const present = stageOutputsPresent();
  const ran: string[] = [];
  const skipped: Array<{ stage: string; reason: string }> = [];

  const wikiChanged = opts.force || sources.find((s) => s.key === "wiki")?.changed || !present.wiki;
  const rulesChanged = opts.force || sources.find((s) => s.key === "rules")?.changed || !present.rules;
  const monstersChanged = opts.force || sources.find((s) => s.key === "monsters")?.changed || !present.monsters;

  if (wikiChanged) {
    if (!findWikiSource()) {
      skipped.push({ stage: "wiki", reason: "未找到 4e Wiki 源文件" });
    } else {
      runExtract(findWikiSource() as string);
      ran.push("extract");
      runClassify();
      ran.push("classify");
      runNormalize();
      ran.push("normalize");
      runGear();
      ran.push("gear");
    }
  } else {
    skipped.push({ stage: "wiki", reason: "源文件指纹未变" });
  }

  if (rulesChanged) {
    if (!findRulesSource()) {
      skipped.push({ stage: "rules", reason: "未找到万律源文件" });
    } else {
      runRules();
      ran.push("rules");
    }
  } else {
    skipped.push({ stage: "rules", reason: "源文件指纹未变" });
  }

  if (monstersChanged) {
    const src = findMonsterSource();
    if (!src) {
      skipped.push({ stage: "monsters", reason: "未找到怪物手册 xlsx" });
    } else {
      runMonsters({ source: src });
      ran.push("monsters");
    }
  } else {
    skipped.push({ stage: "monsters", reason: "源文件指纹未变" });
  }

  // 什么阶段都不用跑、且库已经存在 → 连重建都省掉，直接读 meta 报告
  if (ran.length === 0 && existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const meta = new Map(
        (db.prepare("SELECT key, value FROM meta").all() as unknown as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
      );
      const changed = JSON.parse(meta.get("changes") ?? "{}") as { unchanged?: number };
      return {
        sources,
        ran: [],
        skipped: [...skipped, { stage: "db", reason: "所有来源与规范层均未变化" }],
        databaseChanged: false,
        changes: { added: 0, changed: 0, removed: 0, unchanged: changed.unchanged ?? Number(meta.get("entries") ?? 0) },
        initial: false,
        bytes: 0,
        durationMs: Date.now() - started,
      };
    } finally {
      db.close();
    }
  }

  const built = buildDatabase({ outFile: dbFile });
  ran.push("db");

  const databaseChanged = built.changes.added.length + built.changes.changed.length + built.changes.removed.length > 0;
  if (databaseChanged || opts.exportAlways || opts.force) {
    exportJson();
    ran.push("json");
  } else {
    skipped.push({ stage: "json", reason: "数据库无变更" });
  }

  return {
    sources,
    ran,
    skipped,
    databaseChanged,
    changes: {
      added: built.changes.added.length,
      changed: built.changes.changed.length,
      removed: built.changes.removed.length,
      unchanged: built.changes.unchanged,
    },
    initial: built.changes.initial,
    bytes: built.bytes,
    durationMs: Date.now() - started,
  };
}

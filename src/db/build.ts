import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CANONICAL_DIR,
  DATA_DIR,
  DB_DIR,
  DB_FILE,
  MONSTERS_CANONICAL_DIR,
  RULES_DIR,
} from "../lib/paths.ts";
import { sha256File, sha256Hex } from "../lib/hash.ts";
import { writeJson } from "../lib/io.ts";
import { splitForIndex, toPlainText } from "../lib/text.ts";
import { extractHeadingsWithDepth, extractLinks, extractMacros, extractTransclusions } from "../lib/wikitext.ts";
import { buildSatellites, type RuleMaps } from "./satellites.ts";
import { buildAliasIndex, Resolver } from "./resolve.ts";
import { assignIds, diffEntries, EMPTY_PREV, summarizeChanges, type PrevState, type SyncChanges } from "./diff.ts";
import type { CanonicalRecord, LoadedEntry } from "./model.ts";

/**
 * 规范层 → SQLite。
 *
 * 这是全项目唯一「写库」的地方：先把三份规范层产物读进内存，再一次性灌进 schema.sql
 * 定义的表里。分两趟做，是因为引用解析（`[[火球术]]` 指向哪一条）必须等所有词条都在。
 *
 * 构建是幂等的：每次删库重建，条目 id 按「类别 + 名称排序」分配，同样的输入得到
 * 逐字节相同的库（built_at 除外）。下游据 git diff 就能判断数据变了什么。
 */

export const DB_SCHEMA_VERSION = 1;

/** 书籍代码 → 可读名。只收录确认过的，其余留空由下游自行补，不猜。 */
const BOOK_TITLES: Record<string, { title: string; kind: string }> = {
  PH: { title: "Player's Handbook / 玩家手册", kind: "core" },
  PH2: { title: "Player's Handbook 2 / 玩家手册2", kind: "core" },
  PH3: { title: "Player's Handbook 3 / 玩家手册3", kind: "core" },
  DMG: { title: "Dungeon Master's Guide / 地下城主指南", kind: "core" },
  DMG2: { title: "Dungeon Master's Guide 2 / 地下城主指南2", kind: "core" },
  MM: { title: "Monster Manual / 怪物图鉴", kind: "monster" },
  MM1: { title: "Monster Manual / 怪物图鉴（怪物手册1）", kind: "monster" },
  MM2: { title: "Monster Manual 2 / 怪物图鉴2", kind: "monster" },
  MM3: { title: "Monster Manual 3 / 怪物图鉴3", kind: "monster" },
  AV: { title: "Adventurer's Vault / 冒险者宝库", kind: "supplement" },
  AV2: { title: "Adventurer's Vault 2 / 冒险者宝库2", kind: "supplement" },
  MP: { title: "Martial Power / 武勇之力", kind: "supplement" },
  MP2: { title: "Martial Power 2 / 武勇之力2", kind: "supplement" },
  AP: { title: "Arcane Power / 奥术之力", kind: "supplement" },
  DP: { title: "Divine Power / 神术之力", kind: "supplement" },
  PrP: { title: "Primal Power / 原初之力", kind: "supplement" },
  PsP: { title: "Psionic Power / 灵能之力", kind: "supplement" },
  HoEC: { title: "Heroes of the Elemental Chaos / 元素混沌英雄", kind: "supplement" },
  HoS: { title: "Heroes of Shadow / 暗影英雄", kind: "supplement" },
  HoFL: { title: "Heroes of the Fallen Lands / 失落之地英雄", kind: "supplement" },
  HoFK: { title: "Heroes of the Forgotten Kingdoms / 遗忘王国英雄", kind: "supplement" },
  EPG: { title: "Eberron Player's Guide / 艾伯伦玩家指南", kind: "supplement" },
  FRPG: { title: "Forgotten Realms Player's Guide / 被遗忘的国度玩家指南", kind: "supplement" },
  DSCS: { title: "Dark Sun Campaign Setting / 浩劫残阳战役设定", kind: "supplement" },
  NCS: { title: "Neverwinter Campaign Setting / 无冬城战役设定", kind: "supplement" },
  MME: { title: "Mordenkainen's Magnificent Emporium / 摩登凯南的华丽商场", kind: "supplement" },
  DSH: { title: "Dungeon Survival Handbook / 地城生存手册", kind: "supplement" },
  MotP: { title: "Manual of the Planes / 位面手册", kind: "supplement" },
  MoTP: { title: "Manual of the Planes / 位面手册", kind: "supplement" },
  PHRD: { title: "Player's Handbook Races: Dragonborn / 玩家手册种族：龙裔", kind: "supplement" },
  PHRT: { title: "Player's Handbook Races: Tieflings / 玩家手册种族：提夫林", kind: "supplement" },
  BoVD: { title: "Book of Vile Darkness / 邪恶之书", kind: "supplement" },
  PHHS1: { title: "Player's Handbook Heroes: Series 1 / 玩家手册英雄 系列1", kind: "supplement" },
  PHHS2: { title: "Player's Handbook Heroes: Series 2 / 玩家手册英雄 系列2", kind: "supplement" },
  Demonomicon: { title: "Demonomicon / 恶魔志", kind: "supplement" },
  Dragon: { title: "Dragon Magazine / 龙杂志", kind: "magazine" },
  Dungeon: { title: "Dungeon Magazine / 地城杂志", kind: "magazine" },
};

/**
 * `entry_field` 里不重复存的字段：
 *   · `created` / `modified` / `modifier` 已经是 entry 的列，再存一份就是同一份数据两处落；
 *   · `bag` 在 16223 条里只有 `default` 一个取值，属上游模板的常量噪声。
 * 其余字段（含 `creator`、`revision` 这类没有对应列的）一律保留 —— 无损的前提是「原文还在」，
 * 而完整原文本来就在 `out/raw/tiddlers-raw.jsonl` 与 `entry.source_text` 里。
 */
function isRedundantField(key: string, value: string): boolean {
  if (key === "created" || key === "modified" || key === "modifier") return true;
  if (key === "bag" && value === "default") return true;
  return false;
}

export interface BuildResult {
  file: string;
  bytes: number;
  entries: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  resolvedLinks: number;
  unresolvedLinks: number;
  relations: number;
  changes: SyncChanges;
  durationMs: number;
}

// --- 读取 ------------------------------------------------------------------

function readJsonl(file: string): CanonicalRecord[] {
  if (!existsSync(file)) return [];
  const out: CanonicalRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as CanonicalRecord);
  }
  return out;
}

interface SourceMeta {
  key: string;
  title: string;
  path: string;
  sha256: string;
  bytes: number;
  modified: string | null;
}

function sourceMeta(key: string, title: string, path: string): SourceMeta {
  const rel = path.replace(process.cwd(), "").replace(/^[\\/]/, "").split("\\").join("/");
  if (!existsSync(path)) return { key, title, path: rel, sha256: "", bytes: 0, modified: null };
  const st = statSync(path);
  return { key, title, path: rel, sha256: sha256File(path), bytes: st.size, modified: st.mtime.toISOString() };
}

/** 在 data/ 与仓库根目录里找源文件（文件名命中且扩展名命中，可排除）。 */
function findDataFile(match: RegExp, exts: string[], exclude?: RegExp): string {
  const dirs = [DATA_DIR, process.cwd()];
  const hits: { path: string; mtime: number }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const lower = f.toLowerCase();
      if (!exts.some((x) => lower.endsWith(x))) continue;
      if (!match.test(f)) continue;
      if (exclude && exclude.test(f)) continue;
      const p = join(dir, f);
      try {
        hits.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch {
        /* 读不到修改时间就跳过 */
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.path ?? join(DATA_DIR, `__missing__${exts[0]}`);
}

/** 4e Wiki：按类别读取规范层。类别顺序固定，保证 entry.id 可复现。 */
function loadWikiEntries(): LoadedEntry[] {
  // 规范层是整个管线的中间产物，发行版里只有数据库、没有它 —— 这里必须能容忍缺失，
  // 否则 `node src/cli.ts db` 会抛一个原始的 ENOENT。
  if (!existsSync(CANONICAL_DIR)) return [];
  const files = readdirSync(CANONICAL_DIR).filter((f) => f.endsWith(".jsonl"));
  const categories = files.map((f) => f.slice(0, -6)).sort();
  const out: LoadedEntry[] = [];
  for (const cat of categories) {
    for (const rec of readJsonl(join(CANONICAL_DIR, cat + ".jsonl"))) {
      out.push({
        uid: `${cat}/${rec.id}`,
        sourceKey: "wiki",
        category: cat,
        title: rec.id,
        name: rec.name,
        nameEn: rec.nameEn,
        contentType: typeof rec.type === "string" ? rec.type : "text/vnd.tiddlywiki",
        sourceBook: rec.source,
        magazine: rec.magazine,
        sourceText: rec.sourceText,
        created: rec.fields?.created,
        modified: rec.fields?.modified ?? rec.provenance?.modified,
        modifier: rec.fields?.modifier ?? rec.provenance?.modifier,
        revision: rec.fields?.revision,
        isDerived: cat === "gear" ? 1 : 0,
        fields: rec.fields ?? {},
        tags: rec.tags ?? [],
        headings: extractHeadingsWithDepth(rec.sourceText),
        links: rec.wiki?.links ?? extractLinks(rec.sourceText).map((l) => ({ target: l.target, alias: l.alias })),
        transclusions: rec.wiki?.transclusions ?? extractTransclusions(rec.sourceText),
        macros: rec.wiki?.macros ?? extractMacros(rec.sourceText),
        raw: rec,
      });
    }
  }
  return out;
}

interface RulesPayload {
  chapters: Array<{ title: string; order: number; intro: string; sections: Array<{ title: string; entries: string[] }> }>;
  entries: Array<{
    id: string;
    title: string;
    titleEn?: string;
    kind: string;
    chapter?: string;
    section?: string;
    order: number;
    tags: string[];
    text: string;
    fields: Record<string, string>;
    headings: string[];
    links: { target: string; alias?: string }[];
    transclusions: string[];
    termCategory?: string;
    source?: string;
  }>;
}

function readRulesPayload(): RulesPayload | undefined {
  const file = join(RULES_DIR, "rules.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as RulesPayload;
}

/** 万律：687 条规则词条。 */
function loadRuleEntries(payload: RulesPayload | undefined): LoadedEntry[] {
  if (!payload) return [];
  return payload.entries.map((e) => ({
    uid: `rule/${e.id}`,
    sourceKey: "rules" as const,
    category: "rule",
    title: e.id,
    name: e.title,
    nameEn: e.titleEn,
    contentType: "text/vnd.tiddlywiki",
    sourceBook: e.source ?? "rules-compendium",
    sourceText: e.text,
    isDerived: 0 as const,
    fields: e.fields ?? {},
    tags: e.tags ?? [],
    headings: extractHeadingsWithDepth(e.text),
    links: e.links ?? [],
    transclusions: e.transclusions ?? [],
    macros: extractMacros(e.text),
    raw: e as unknown as CanonicalRecord,
  }));
}

/** 怪物手册：927 条。 */
function loadMonsterEntries(): LoadedEntry[] {
  const file = join(MONSTERS_CANONICAL_DIR, "monster.jsonl");
  if (!existsSync(file)) return [];
  return readJsonl(file).map((rec) => ({
    uid: `monster/${rec.id}`,
    sourceKey: "monsters" as const,
    category: "monster",
    title: rec.id,
    name: rec.name,
    nameEn: rec.nameEn,
    contentType: "text/vnd.tiddlywiki",
    sourceBook: typeof rec.book === "string" ? rec.book : undefined,
    sourceText: rec.sourceText,
    isDerived: 0 as const,
    fields: rec.fields ?? {},
    tags: [],
    headings: [],
    links: [],
    transclusions: [],
    macros: [],
    raw: rec,
  }));
}

// --- 引用解析 --------------------------------------------------------------

/**
 * 解析一个 wiki 引用目标（实现见 resolve.ts：精确命中 → 唯一前缀命中，有歧义就放弃）。
 * 这里只是把 Resolver 绑到当前词条集上，方便调用点少传参数。
 */


// --- 构建 ------------------------------------------------------------------

/** 读上一版数据库里的 uid → (id, contentHash)，用于增量分配 id 与算变更。 */
function readPrevState(file: string): PrevState {
  if (!existsSync(file)) return EMPTY_PREV;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const hasTable = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'entry'")
      .get() as { n: number };
    if (!hasTable.n) return EMPTY_PREV;
    const rows = db.prepare("SELECT id, uid, content_hash FROM entry").all() as Array<{
      id: number;
      uid: string;
      content_hash: string;
    }>;
    const entries = new Map<string, { id: number; contentHash: string }>();
    let maxId = 0;
    for (const r of rows) {
      entries.set(r.uid, { id: r.id, contentHash: r.content_hash });
      if (r.id > maxId) maxId = r.id;
    }
    return { entries, maxId, existed: rows.length > 0 };
  } finally {
    db.close();
  }
}

export function buildDatabase(opts: { outFile?: string } = {}): BuildResult {
  const started = Date.now();
  const outFile = opts.outFile ?? DB_FILE;
  mkdirSync(DB_DIR, { recursive: true });

  // 增量：先读上一版的 uid→id 映射，再写到临时文件，最后原子替换。
  // 这样「构建失败」不会留下半个库，旧库也不会在构建途中被删。
  // 临时库写在 out/db/ 里，不在仓库根目录留任何中间文件。
  const prev = readPrevState(outFile);
  const tmpFile = join(DB_DIR, `.building-${process.pid}.db`);
  if (existsSync(tmpFile)) rmSync(tmpFile);
  // 清掉上次崩溃/被中断留下的半成品，避免它们堆积成大文件
  if (existsSync(DB_DIR)) {
    for (const f of readdirSync(DB_DIR)) {
      if (f.startsWith(".building-") && f.endsWith(".db")) rmSync(join(DB_DIR, f), { force: true });
    }
  }

  const rulesPayload = readRulesPayload();
  const entries: LoadedEntry[] = [...loadWikiEntries(), ...loadRuleEntries(rulesPayload), ...loadMonsterEntries()];
  if (entries.length === 0) {
    throw new Error(
      "没有可入库的词条：out/canonical/（规范层）为空或不存在。\n" +
        "    重建需要三个源文件放在 data/ 下，然后运行 npm run rebuild；\n" +
        "    只做数据接入则不需要重建 —— 数据库已随仓库提供（4e-next-core.db）。",
    );
  }

  // 稳定顺序：类别排序 + 名称排序。**首次导入**时 entry.id 依赖它。
  const collator = new Intl.Collator("zh-CN");
  entries.sort((a, b) =>
    a.category === b.category
      ? collator.compare(a.name, b.name) || collator.compare(a.title, b.title)
      : a.category < b.category
        ? -1
        : 1,
  );
  const ordByCategory = new Map<string, number>();
  for (const e of entries) {
    const n = ordByCategory.get(e.category) ?? 0;
    ordByCategory.set(e.category, n + 1);
    e.ord = n;
  }

  // 增量分配 id：同 uid 沿用上一版，新 uid 接在最大号之后
  const hashes = new Map<string, string>();
  for (const e of entries) hashes.set(e.uid, sha256Hex(e.sourceText));
  const { ids } = assignIds(entries, prev);
  entries.forEach((e, i) => {
    e.id = ids[i];
  });
  const changes = diffEntries(
    entries.map((e) => ({ uid: e.uid, contentHash: hashes.get(e.uid) as string })),
    prev,
  );

  const db = new DatabaseSync(tmpFile);
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

  const wikiSrc = sourceMeta("wiki", "4e Wiki（风之守护维护）", findDataFile(/wiki|维基/i, [".htm", ".html"]));
  const rulesSrc = sourceMeta("rules", "4e 万律（4e Rules Compendium）", findDataFile(/rule|万律/i, [".htm", ".html"], /wiki|维基/i));
  const monsterSrc = sourceMeta("monsters", "DnD4E 怪物手册 1~3 合订本", findDataFile(/怪物/, [".xlsx"]));
  const now = new Date().toISOString();

  let resolved = 0;
  let unresolved = 0;
  let relationCount = 0;

  db.exec("BEGIN");
  try {
    const insSource = db.prepare(
      "INSERT INTO source (key, title, path, sha256, bytes, modified, built_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of [wikiSrc, rulesSrc, monsterSrc]) {
      insSource.run(s.key, s.title, s.path, s.sha256, s.bytes, s.modified, now, null);
    }

    const codes = new Set<string>();
    for (const e of entries) if (e.sourceBook) codes.add(e.sourceBook);
    const insBook = db.prepare("INSERT OR IGNORE INTO book (code, title, kind) VALUES (?, ?, ?)");
    for (const code of [...codes].sort()) {
      const known = BOOK_TITLES[code];
      insBook.run(code, known?.title ?? null, known?.kind ?? "other");
    }

    const insEntry = db.prepare(
      `INSERT INTO entry (id, uid, source_key, category, title, name, name_en, content_type, source_book, magazine,
        source_text, content_hash, created, modified, modifier, revision, ord, is_derived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      insEntry.run(
        e.id as number,
        e.uid,
        e.sourceKey,
        e.category,
        e.title,
        e.name,
        e.nameEn ?? null,
        e.contentType ?? null,
        e.sourceBook ?? null,
        e.magazine ?? null,
        e.sourceText,
        hashes.get(e.uid) as string,
        e.created ?? null,
        e.modified ?? null,
        e.modifier ?? null,
        e.revision ?? null,
        e.ord ?? 0,
        e.isDerived,
      );
    }

    // --- 通用子表 ---
    const insField = db.prepare("INSERT OR REPLACE INTO entry_field (entry_id, key, value) VALUES (?, ?, ?)");
    const insTagName = db.prepare("INSERT OR IGNORE INTO tag (name) VALUES (?)");
    const getTagId = db.prepare("SELECT id FROM tag WHERE name = ?");
    const insEntryTag = db.prepare("INSERT OR REPLACE INTO entry_tag (entry_id, tag_id) VALUES (?, ?)");
    const insHeading = db.prepare("INSERT OR REPLACE INTO entry_heading (entry_id, ord, depth, text) VALUES (?, ?, ?, ?)");
    const insMacro = db.prepare("INSERT OR REPLACE INTO entry_macro (entry_id, ord, name) VALUES (?, ?, ?)");
    const tagIds = new Map<string, number>();

    for (const e of entries) {
      const id = e.id as number;
      for (const [k, v] of Object.entries(e.fields)) {
        if (isRedundantField(k, v)) continue;
        insField.run(id, k, v);
      }
      for (const t of e.tags) {
        let tid = tagIds.get(t);
        if (tid === undefined) {
          insTagName.run(t);
          const row = getTagId.get(t) as { id: number } | undefined;
          tid = row?.id ?? 0;
          tagIds.set(t, tid);
        }
        if (tid) insEntryTag.run(id, tid);
      }
      e.headings.forEach((h, i) => insHeading.run(id, i, h.depth, h.text));
      e.macros.forEach((m, i) => insMacro.run(id, i, m));
    }

    // --- 万律章节结构（必须在 rule_meta 之前）---
    const ruleMaps: RuleMaps = { chapters: new Map(), sections: new Map() };    if (rulesPayload) {
      const insChapter = db.prepare("INSERT OR IGNORE INTO rule_chapter (title, ord, intro) VALUES (?, ?, ?)");
      const getChapter = db.prepare("SELECT id FROM rule_chapter WHERE title = ?");
      const insSection = db.prepare("INSERT INTO rule_section (chapter_id, title, ord) VALUES (?, ?, ?)");
      for (const ch of rulesPayload.chapters) {
        insChapter.run(ch.title, ch.order, ch.intro);
        const row = getChapter.get(ch.title) as { id: number } | undefined;
        if (!row) continue;
        ruleMaps.chapters.set(ch.title, row.id);
        ch.sections.forEach((sec, i) => {
          const info = insSection.run(row.id, sec.title, i);
          ruleMaps.sections.set(`${ch.title}::${sec.title}`, Number(info.lastInsertRowid));
        });
      }
    }

    // --- 类别卫星表 ---
    const resolver = new Resolver(entries, buildAliasIndex(entries));
    const sat = buildSatellites(db, entries, resolver, ruleMaps);

    // --- 引用解析（要等所有 entry.id 就绪）---
    const insLink = db.prepare(
      "INSERT INTO entry_link (entry_id, ord, target_title, alias, target_entry_id) VALUES (?, ?, ?, ?, ?)",
    );
    const insTrans = db.prepare(
      "INSERT INTO entry_transclusion (entry_id, ord, target_title, target_entry_id) VALUES (?, ?, ?, ?)",
    );
    const insRelation = db.prepare("INSERT INTO relation (from_entry_id, to_entry_id, kind, ord) VALUES (?, ?, ?, ?)");
    const seenEdge = new Set<string>();
    const addEdge = (from: number, to: number, kind: string, ord: number): void => {
      if (from === to) return;
      const k = `${from}|${to}|${kind}`;
      if (seenEdge.has(k)) return;
      seenEdge.add(k);
      insRelation.run(from, to, kind, ord);
      relationCount++;
    };

    for (const e of entries) {
      const id = e.id as number;
      e.links.forEach((l, i) => {
        const target = resolver.resolve(l.target);
        if (target !== undefined) {
          resolved++;
          addEdge(id, target, "link", i);
        } else {
          unresolved++;
        }
        insLink.run(id, i, l.target, l.alias ?? null, target ?? null);
      });
      e.transclusions.forEach((t, i) => {
        const target = resolver.resolve(t);
        if (target !== undefined) addEdge(id, target, "transclusion", i);
        insTrans.run(id, i, t, target ?? null);
      });
    }

    for (const [from, to] of sat.grantEdges) addEdge(from, to, "grantor", 0);
    for (const [from, to] of sat.prereqEdges) addEdge(from, to, "prerequisite", 0);

    // --- 全文检索 ---
    const insFts = db.prepare("INSERT INTO entry_fts (rowid, name, name_en, body, keywords) VALUES (?, ?, ?, ?, ?)");
    for (const e of entries) {
      insFts.run(
        e.id as number,
        splitForIndex(e.name),
        e.nameEn ? splitForIndex(e.nameEn) : "",
        splitForIndex(toPlainText(e.sourceText)),
        splitForIndex(collectKeywords(e)),
      );
    }

    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const e of entries) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      bySource[e.sourceKey] = (bySource[e.sourceKey] ?? 0) + 1;
    }

    const insMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    insMeta.run("schema_version", String(DB_SCHEMA_VERSION));
    insMeta.run("built_at", now);
    insMeta.run("entries", String(entries.length));
    insMeta.run("by_category", JSON.stringify(byCategory));
    insMeta.run("by_source", JSON.stringify(bySource));
    insMeta.run("resolved_links", String(resolved));
    insMeta.run("unresolved_links", String(unresolved));
    insMeta.run("relations", String(relationCount));
    insMeta.run("changes", JSON.stringify(summarizeChanges(changes).counts));

    db.prepare("INSERT INTO build (built_at, schema_version, entries, stats) VALUES (?, ?, ?, ?)").run(
      now,
      DB_SCHEMA_VERSION,
      entries.length,
      JSON.stringify({ byCategory, bySource, changes: summarizeChanges(changes).counts }),
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.close();
    if (existsSync(tmpFile)) rmSync(tmpFile);
    throw err;
  }

  db.exec("PRAGMA optimize");
  db.exec("VACUUM");
  db.close();

  // 原子替换：临时文件落定后才删旧库
  // Windows 上如果旧库正被别的进程打开（比如 `cli.ts serve`），删除会失败 —— 这里给出明确提示，
  // 而不是抛一个只有 errno 的 EBUSY。
  try {
    if (existsSync(outFile)) rmSync(outFile);
    renameSync(tmpFile, outFile);
  } catch (err) {
    if (existsSync(tmpFile)) rmSync(tmpFile);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new Error(`数据库文件正被其它进程占用（${outFile}）。如果开着 \`node src/cli.ts serve\`，先停掉再重建。`);
    }
    throw err;
  }

  // 变更清单单独落盘：几万条 uid 塞进数据库没有意义，放文件里方便 diff 与 CI 断言
  writeJson(join(DB_DIR, "_changes.json"), {
    generatedAt: now,
    entries: entries.length,
    ...summarizeChanges(changes),
  });

  return {
    file: outFile,
    bytes: statSync(outFile).size,
    entries: entries.length,
    byCategory: countBy(entries, (e) => e.category),
    bySource: countBy(entries, (e) => e.sourceKey),
    resolvedLinks: resolved,
    unresolvedLinks: unresolved,
    relations: relationCount,
    changes,
    durationMs: Date.now() - started,
  };
}

function countBy(entries: LoadedEntry[], key: (e: LoadedEntry) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[key(e)] = (out[key(e)] ?? 0) + 1;
  return out;
}

function collectKeywords(e: LoadedEntry): string {
  const parts: string[] = [];
  const k = e.raw.keywords;
  if (typeof k === "string") parts.push(k);
  for (const key of [
    "usageZh",
    "actionType",
    "powerType",
    "grantedBy",
    "tierZh",
    "itemCategory",
    "itemSuitable",
    "rarity",
    "role",
    "powerSource",
    "keySkill",
    "ritualCategory",
    "kind",
  ]) {
    const v = e.raw[key];
    if (typeof v === "string" && v) parts.push(v);
  }
  return parts.join(" ");
}

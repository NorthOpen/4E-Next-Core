import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSON_DIR } from "../lib/paths.ts";
import { openDb } from "../api/index.ts";
import type { EntryRow } from "../schema/db.ts";

/**
 * 浏览器用 JSON 包：**从数据库导出**，不是另一条管线。
 *
 * 这样只有一个事实来源——数据库改了什么，JSON 就是什么，不会出现「库里对了、包里还是旧的」。
 *
 * 产出：
 *   out/json/manifest.json         清单（版本、构建时间、各类计数、文件表）
 *   out/json/entries.json          全部词条的轻量索引（不含正文），给列表页/搜索页用
 *   out/json/categories/<cat>.json 按类别的完整词条（含卫星表与拆好的段）
 *   out/json/relations.json        关系边（from uid → to uid）
 *   out/json/glossary.json         译名词典（en → zh）
 */

export interface JsonExportResult {
  dir: string;
  files: number;
  bytes: number;
}

const CATEGORIES = [
  "race",
  "class",
  "paragon-path",
  "epic-destiny",
  "feat",
  "power",
  "equipment",
  "item-set",
  "ritual",
  "theme",
  "domain",
  "magic-school",
  "pact",
  "vice",
  "virtue",
  "bloodline",
  "creature",
  "reference",
  "nav",
  "dictionary",
  "gear",
  "monster",
  "rule",
];

export function exportJson(opts: { dir?: string } = {}): JsonExportResult {
  const dir = opts.dir ?? JSON_DIR;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "categories"), { recursive: true });

  const db = openDb();
  const files: Array<{ path: string; bytes: number; entries: number }> = [];
  const write = (rel: string, data: unknown, entries: number): void => {
    const body = JSON.stringify(data);
    writeFileSync(join(dir, rel), body, "utf8");
    files.push({ path: rel, bytes: Buffer.byteLength(body), entries });
  };

  try {
    const stats = db.stats();

    // 轻量索引：一切列表页都只需要这些列
    const index = db.sql<EntryRow>(
      `SELECT id, uid, category, title, name, name_en, source_book, magazine, content_type
         FROM entry ORDER BY category, ord`,
    );
    write("entries.json", index, index.length);

    // 按类别的完整词条。剔掉 related：关系边已经整份在 relations.json 里，重复会让包体积翻倍。
    for (const cat of CATEGORIES) {
      const rows = db.sql<{ id: number }>("SELECT id FROM entry WHERE category = ? ORDER BY ord", cat);
      if (rows.length === 0) continue;
      const list = rows
        .map((r) => db.entry(r.id))
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .map((x) => {
          const { related: _rel, ...rest } = x;
          return rest;
        });
      write(`categories/${cat}.json`, list, list.length);
    }

    // 关系边
    const edges = db.sql<{ from_uid: string; to_uid: string; kind: string }>(
      `SELECT a.uid AS from_uid, b.uid AS to_uid, r.kind
         FROM relation r JOIN entry a ON a.id = r.from_entry_id JOIN entry b ON b.id = r.to_entry_id
        ORDER BY r.kind, a.uid`,
    );
    write("relations.json", edges, edges.length);

    // 译名词典
    const glossary = db.sql<{ en: string; zh: string }>("SELECT en, zh FROM glossary_term ORDER BY en");
    write("glossary.json", glossary, glossary.length);

    const manifest = {
      schemaVersion: stats.schemaVersion,
      builtAt: stats.builtAt,
      entries: stats.entries,
      byCategory: stats.byCategory,
      bySource: stats.bySource,
      relations: edges.length,
      files: files.map((f) => ({ path: f.path, bytes: f.bytes, entries: f.entries })),
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    return {
      dir,
      files: files.length + 1,
      bytes: files.reduce((a, f) => a + f.bytes, 0),
    };
  } finally {
    db.close();
  }
}

/** 直接读一个类别（给不做 SQL 的下游用）。 */
export function readCategoryJson(cat: string, dir: string = JSON_DIR): unknown {
  return JSON.parse(readFileSync(join(dir, "categories", `${cat}.json`), "utf8")) as unknown;
}

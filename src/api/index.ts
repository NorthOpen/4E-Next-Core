import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "../lib/paths.ts";
import { buildFtsQuery } from "../lib/text.ts";
import type {
  BookRow,
  EntryDetail,
  EntryRow,
  EquipmentRow,
  FeatRow,
  ItemBlockRow,
  MonsterPowerRow,
  MonsterRow,
  PowerPartRow,
  PowerRow,
  RuleMetaRow,
  SearchHit,
  Stats,
} from "../schema/db.ts";

/**
 * 类型化查询层。
 *
 * 设计目标：下游开发者拿到 `out/db/4e-next-core.db` 后，既可以写裸 SQL，
 * 也可以只用这一个类——常见的十几种查法都已经封装好，返回值是 db.ts 里的类型。
 *
 * 全部同步（node:sqlite 是同步 API），因此不返回 Promise，CLI / 服务端 / 测试里都能直接用。
 */

export interface SearchOptions {
  limit?: number;
  offset?: number;
  category?: string;
  /** 只在这些类别里搜 */
  categories?: string[];
}

export interface ListOptions {
  category?: string;
  book?: string;
  /** 名称子串 */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MonsterFilter {
  levelMin?: number;
  levelMax?: number;
  rank?: string;
  role?: string;
  book?: string;
  origin?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export class WikiDb {
  readonly raw: DatabaseSync;
  readonly file: string;

  constructor(file: string = DB_FILE) {
    if (!existsSync(file)) {
      throw new Error(`找不到数据库 ${file}；先运行 node src/cli.ts db`);
    }
    this.file = file;
    this.raw = new DatabaseSync(file, { readOnly: true });
  }

  prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
    return this.raw.prepare(sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }

  /** 任意 SQL，返回行数组。 */
  sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[] {
    return this.raw.prepare(query).all(...(params as never[])) as T[];
  }

  // --- 元信息 --------------------------------------------------------------

  meta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.raw.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>) {
      out[row.key] = row.value;
    }
    return out;
  }

  stats(): Stats {
    const meta = this.meta();
    return {
      schemaVersion: Number(meta.schema_version ?? 0),
      builtAt: meta.built_at ?? "",
      entries: Number(meta.entries ?? 0),
      byCategory: JSON.parse(meta.by_category ?? "{}") as Record<string, number>,
      bySource: JSON.parse(meta.by_source ?? "{}") as Record<string, number>,
      relations: Number(meta.relations ?? 0),
    };
  }

  books(): BookRow[] {
    return this.raw
      .prepare(
        `SELECT b.code, b.title, b.kind, COUNT(e.id) AS entries
           FROM book b LEFT JOIN entry e ON e.source_book = b.code
          GROUP BY b.code ORDER BY entries DESC, b.code`,
      )
      .all() as unknown as BookRow[];
  }

  categories(): Array<{ category: string; entries: number }> {
    return this.raw
      .prepare("SELECT category, COUNT(*) AS entries FROM entry GROUP BY category ORDER BY entries DESC")
      .all() as unknown as Array<{ category: string; entries: number }>;
  }

  // --- 检索 ----------------------------------------------------------------

  /**
   * 全文检索。中文按「连续子串」匹配（见 lib/text.ts 的切分规则），
   * 拉丁词按前缀匹配；结果按 bm25 相关度排序。
   */
  search(text: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const q = buildFtsQuery(text);
    if (!q) return [];

    const cats = opts.categories ?? (opts.category ? [opts.category] : []);
    const filter = cats.length > 0 ? ` AND e.category IN (${cats.map(() => "?").join(", ")})` : "";
    const rows = this.raw
      .prepare(
        `SELECT e.id, e.uid, e.category, e.name, e.name_en,
                snippet(entry_fts, 2, '[', ']', '…', 16) AS snippet,
                bm25(entry_fts) AS score
           FROM entry_fts JOIN entry e ON e.id = entry_fts.rowid
          WHERE entry_fts MATCH ?${filter}
          ORDER BY score
          LIMIT ? OFFSET ?`,
      )
      .all(q, ...(cats as never[]), limit, offset) as unknown as SearchHit[];
    return rows;
  }

  // --- 词条 ----------------------------------------------------------------

  /** 按 uid 或数字 id 取一条词条（带卫星表与关系边）。 */
  entry(uidOrId: string | number): EntryDetail | null {
    const row =
      typeof uidOrId === "number"
        ? (this.raw.prepare("SELECT * FROM entry WHERE id = ?").get(uidOrId) as EntryRow | undefined)
        : (this.raw.prepare("SELECT * FROM entry WHERE uid = ?").get(uidOrId) as EntryRow | undefined);
    if (!row) return null;
    return this.expand(row);
  }

  entryByUid(uid: string): EntryDetail | null {
    return this.entry(uid);
  }

  /** 按名称取：先精确匹配 title，再匹配中文名。 */
  find(name: string): EntryRow | null {
    const byTitle = this.raw.prepare("SELECT * FROM entry WHERE title = ? LIMIT 1").get(name) as EntryRow | undefined;
    if (byTitle) return byTitle;
    const byUid = this.raw.prepare("SELECT * FROM entry WHERE uid = ? LIMIT 1").get(name) as EntryRow | undefined;
    if (byUid) return byUid;
    const byName = this.raw.prepare("SELECT * FROM entry WHERE name = ? ORDER BY id LIMIT 1").get(name) as EntryRow | undefined;
    return byName ?? null;
  }

  list(opts: ListOptions = {}): EntryRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.category) {
      where.push("category = ?");
      params.push(opts.category);
    }
    if (opts.book) {
      where.push("source_book = ?");
      params.push(opts.book);
    }
    if (opts.q) {
      where.push("(name LIKE ? OR title LIKE ? OR name_en LIKE ?)");
      params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
    }
    const sql =
      "SELECT * FROM entry" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY category, ord LIMIT ? OFFSET ?";
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.raw.prepare(sql).all(...(params as never[])) as unknown as EntryRow[];
  }

  /**
   * 某职业/典范/专长授予的全部威能（含基本攻击与特性）。
   *
   * 返回的是 `entry.* + power.*` 的**扁平合并行**（两表列名不冲突），
   * 所以既能直接读 `row.name`，也能直接读 `row.level`。
   */
  powersByGrantor(grantor: string | number): Array<EntryRow & PowerRow> {
    return this.raw
      .prepare(
        `SELECT e.*, p.* FROM power p JOIN entry e ON e.id = p.entry_id
          WHERE p.grantor_entry_id = ? OR p.granted_by = ?
          ORDER BY p.level, e.name`,
      )
      .all(grantor, grantor) as unknown as Array<EntryRow & PowerRow>;
  }

  /** 怪物筛选：等级区间 / 职能 / 书 / 界域 / 名称子串。返回 `entry.* + monster.*` 的扁平合并行。 */
  monsters(filter: MonsterFilter = {}): Array<EntryRow & MonsterRow> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.levelMin !== undefined) {
      where.push("m.level >= ?");
      params.push(filter.levelMin);
    }
    if (filter.levelMax !== undefined) {
      where.push("m.level <= ?");
      params.push(filter.levelMax);
    }
    if (filter.role) {
      where.push("m.role = ?");
      params.push(filter.role);
    }
    if (filter.rank) {
      where.push("m.rank = ?");
      params.push(filter.rank);
    }
    if (filter.book) {
      where.push("m.book = ?");
      params.push(filter.book);
    }
    if (filter.origin) {
      where.push("m.origin = ?");
      params.push(filter.origin);
    }
    if (filter.q) {
      where.push("(e.name LIKE ? OR e.name_en LIKE ?)");
      params.push(`%${filter.q}%`, `%${filter.q}%`);
    }
    const sql =
      `SELECT e.*, m.* FROM monster m JOIN entry e ON e.id = m.entry_id` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY m.level, e.name LIMIT ? OFFSET ?";
    params.push(filter.limit ?? 100, filter.offset ?? 0);
    return this.raw.prepare(sql).all(...(params as never[])) as unknown as Array<EntryRow & MonsterRow>;
  }

  /** 关系图：出边 / 入边。kind 可选（link / transclusion / grantor / prerequisite）。 */
  related(
    id: number,
    opts: { kind?: string; direction?: "out" | "in" | "both"; limit?: number } = {},
  ): Array<{ kind: string; entry_id: number; uid: string; name: string; category: string }> {
    const limit = opts.limit ?? 200;
    const dir = opts.direction ?? "both";
    const kindFilter = opts.kind ? " AND r.kind = ?" : "";
    const out: Array<{ kind: string; entry_id: number; uid: string; name: string; category: string }> = [];

    if (dir === "out" || dir === "both") {
      const params: unknown[] = [id];
      if (opts.kind) params.push(opts.kind);
      params.push(limit);
      out.push(
        ...(this.raw
          .prepare(
            `SELECT r.kind, e.id AS entry_id, e.uid, e.name, e.category
               FROM relation r JOIN entry e ON e.id = r.to_entry_id
              WHERE r.from_entry_id = ?${kindFilter} LIMIT ?`,
          )
          .all(...(params as never[])) as unknown as typeof out),
      );
    }
    if (dir === "in" || dir === "both") {
      const params: unknown[] = [id];
      if (opts.kind) params.push(opts.kind);
      params.push(limit);
      out.push(
        ...(this.raw
          .prepare(
            `SELECT r.kind, e.id AS entry_id, e.uid, e.name, e.category
               FROM relation r JOIN entry e ON e.id = r.from_entry_id
              WHERE r.to_entry_id = ?${kindFilter} LIMIT ?`,
          )
          .all(...(params as never[])) as unknown as typeof out),
      );
    }
    return out;
  }

  /** 把一行 entry 展开成完整词条。 */
  private expand(row: EntryRow): EntryDetail {
    const id = row.id;
    const fields: Record<string, string> = {};
    for (const f of this.raw.prepare("SELECT key, value FROM entry_field WHERE entry_id = ?").all(id) as Array<{ key: string; value: string }>) {
      fields[f.key] = f.value;
    }
    const tags = (
      this.raw.prepare("SELECT t.name FROM entry_tag et JOIN tag t ON t.id = et.tag_id WHERE et.entry_id = ? ORDER BY t.name").all(id) as Array<{
        name: string;
      }>
    ).map((t) => t.name);

    const headings = this.raw
      .prepare("SELECT depth, text FROM entry_heading WHERE entry_id = ? ORDER BY ord")
      .all(id) as unknown as Array<{ depth: number; text: string }>;

    const links = this.raw
      .prepare("SELECT target_title, alias, target_entry_id FROM entry_link WHERE entry_id = ? ORDER BY ord")
      .all(id) as unknown as Array<{ target_title: string; alias: string | null; target_entry_id: number | null }>;

    const transclusions = this.raw
      .prepare("SELECT target_title, target_entry_id FROM entry_transclusion WHERE entry_id = ? ORDER BY ord")
      .all(id) as unknown as Array<{ target_title: string; target_entry_id: number | null }>;

    const macros = (
      this.raw.prepare("SELECT name FROM entry_macro WHERE entry_id = ? ORDER BY ord").all(id) as Array<{ name: string }>
    ).map((m) => m.name);

    const detail: EntryDetail = { ...row, fields, tags, headings, links, transclusions, macros, related: [] };
    detail.related = this.related(id, { limit: 200 }).map((r) => ({
      kind: r.kind,
      entry_id: r.entry_id,
      uid: r.uid,
      name: r.name,
      category: r.category,
    }));

    switch (row.category) {
      case "power": {
        const p = this.raw.prepare("SELECT * FROM power WHERE entry_id = ?").get(id) as PowerRow | undefined;
        if (p) {
          const parts = this.raw.prepare("SELECT * FROM power_part WHERE entry_id = ? ORDER BY ord").all(id) as unknown as PowerPartRow[];
          const keywordList = (
            this.raw.prepare("SELECT keyword FROM power_keyword WHERE entry_id = ? ORDER BY ord").all(id) as Array<{ keyword: string }>
          ).map((k) => k.keyword);
          detail.power = { ...p, parts, keywordList };
        }
        break;
      }
      case "feat": {
        const f = this.raw.prepare("SELECT * FROM feat WHERE entry_id = ?").get(id) as FeatRow | undefined;
        if (f) {
          const prerequisites = this.raw
            .prepare("SELECT ord, text, target_entry_id, target_title FROM prerequisite WHERE entry_id = ? ORDER BY ord")
            .all(id) as unknown as Array<{ ord: number; text: string; target_entry_id: number | null; target_title: string | null }>;
          detail.feat = { ...f, prerequisites };
        }
        break;
      }
      case "equipment": {
        const e = this.raw.prepare("SELECT * FROM equipment WHERE entry_id = ?").get(id) as EquipmentRow | undefined;
        if (e) {
          const levels = this.raw.prepare("SELECT level, suffix FROM item_level WHERE entry_id = ? ORDER BY ord").all(id) as unknown as Array<{
            level: number;
            suffix: string | null;
          }>;
          const blocks = this.raw.prepare("SELECT * FROM item_block WHERE entry_id = ? ORDER BY ord").all(id) as unknown as ItemBlockRow[];
          detail.equipment = { ...e, levels, blocks };
        }
        break;
      }
      case "race": {
        const r = this.raw.prepare("SELECT * FROM race WHERE entry_id = ?").get(id) as EntryDetail["race"] | undefined;
        if (r) detail.race = r;
        break;
      }
      case "class": {
        const c = this.raw.prepare("SELECT * FROM class WHERE entry_id = ?").get(id) as EntryDetail["classInfo"] | undefined;
        if (c) detail.classInfo = c;
        break;
      }
      case "ritual": {
        const r = this.raw.prepare("SELECT * FROM ritual WHERE entry_id = ?").get(id) as
          | { level: number | null; key_skill: string | null; category: string | null }
          | undefined;
        if (r) {
          const facts = this.raw.prepare("SELECT key, value FROM ritual_fact WHERE entry_id = ?").all(id) as unknown as Array<{ key: string; value: string }>;
          detail.ritual = { ...r, facts };
        }
        break;
      }
      case "gear": {
        const g = this.raw.prepare("SELECT * FROM gear WHERE entry_id = ?").get(id) as
          | {
              item_category: string | null;
              group_name: string | null;
              cost: string | null;
              cost_cp: number | null;
              weight: string | null;
              weight_lb: number | null;
              is_kit: number;
              contents: string;
            }
          | undefined;
        if (g) detail.gear = { ...g, contents: safeJsonArray(g.contents) };
        break;
      }
      case "monster": {
        const m = this.raw.prepare("SELECT * FROM monster WHERE entry_id = ?").get(id) as MonsterRow | undefined;
        if (m) {
          const abilities: Record<string, { score: number | null; modifier: string | null }> = {};
          for (const a of this.raw.prepare("SELECT ability, score, modifier FROM monster_ability WHERE entry_id = ?").all(id) as Array<{
            ability: string;
            score: number | null;
            modifier: string | null;
          }>) {
            abilities[a.ability] = { score: a.score, modifier: a.modifier };
          }
          const skills = this.raw.prepare("SELECT name, bonus FROM monster_skill WHERE entry_id = ? ORDER BY ord").all(id) as unknown as Array<{
            name: string;
            bonus: string | null;
          }>;
          const languages = (
            this.raw.prepare("SELECT language FROM monster_language WHERE entry_id = ? ORDER BY ord").all(id) as Array<{ language: string }>
          ).map((x) => x.language);
          const equipment = (
            this.raw.prepare("SELECT name FROM monster_equipment WHERE entry_id = ? ORDER BY ord").all(id) as Array<{ name: string }>
          ).map((x) => x.name);
          const notes = this.raw.prepare("SELECT kind, text FROM monster_defense_note WHERE entry_id = ? ORDER BY kind, ord").all(id) as unknown as Array<{
            kind: string;
            text: string;
          }>;
          const powers = (
            this.raw.prepare("SELECT * FROM monster_power WHERE entry_id = ? ORDER BY ord").all(id) as unknown as MonsterPowerRow[]
          ).map((p) => {
            const parts = this.raw
              .prepare("SELECT label, text FROM monster_power_part WHERE monster_power_id = ? ORDER BY ord")
              .all(p.id) as unknown as Array<{ label: string; text: string }>;
            const keywords = (
              this.raw.prepare("SELECT keyword FROM monster_power_keyword WHERE monster_power_id = ? ORDER BY ord").all(p.id) as Array<{
                keyword: string;
              }>
            ).map((k) => k.keyword);
            return { ...p, parts, keywords };
          });
          detail.monster = { ...m, abilities, skills, languages, equipment, notes, powers };
        }
        break;
      }
      case "rule": {
        const r = this.raw.prepare("SELECT * FROM rule_meta WHERE entry_id = ?").get(id) as RuleMetaRow | undefined;
        if (r) detail.rule = r;
        break;
      }
      default:
        break;
    }
    return detail;
  }
}

function safeJsonArray(text: string | null): string[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 打开数据库（默认 out/db/4e-next-core.db）。 */
export function openDb(file: string = DB_FILE): WikiDb {
  return new WikiDb(file);
}

export type {
  BookRow,
  EntryDetail,
  EntryRow,
  PowerRow,
  PowerPartRow,
  FeatRow,
  EquipmentRow,
  ItemBlockRow,
  MonsterRow,
  MonsterPowerRow,
  RuleMetaRow,
  SearchHit,
  Stats,
} from "../schema/db.ts";
export type { Category, SourceKey } from "../schema/db.ts";

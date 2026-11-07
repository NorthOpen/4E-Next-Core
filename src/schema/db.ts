/**
 * 数据库行的 TypeScript 类型。**零运行时依赖**：只有 type/interface，
 * 下游 `import type` 进来即可获得补全，不需要安装任何包。
 *
 * 字段与 src/db/schema.sql 一一对应；改 DDL 时必须同步改这里（tests/schema.test.mjs 会校验）。
 */

export type Category =
  | "race"
  | "class"
  | "paragon-path"
  | "epic-destiny"
  | "feat"
  | "power"
  | "equipment"
  | "item-set"
  | "ritual"
  | "theme"
  | "domain"
  | "magic-school"
  | "pact"
  | "vice"
  | "virtue"
  | "bloodline"
  | "creature"
  | "reference"
  | "nav"
  | "dictionary"
  | "gear"
  | "monster"
  | "rule";

export type SourceKey = "wiki" | "rules" | "monsters";

/** entry：三条来源共有的主表。 */
export interface EntryRow {
  id: number;
  uid: string;
  source_key: SourceKey;
  category: Category | string;
  title: string;
  name: string;
  name_en: string | null;
  content_type: string | null;
  source_book: string | null;
  magazine: string | null;
  source_text: string;
  content_hash: string;
  created: string | null;
  modified: string | null;
  modifier: string | null;
  revision: string | null;
  ord: number;
  is_derived: number;
}

export interface PowerRow {
  entry_id: number;
  level: number | null;
  usage: string | null;
  usage_zh: string | null;
  action_type: string | null;
  power_type: string | null;
  power_kind: string | null;
  granted_by: string | null;
  grantor_entry_id: number | null;
  range: string | null;
  keywords: string | null;
  skill: string | null;
  flavor_text: string | null;
  has_attack: number;
}

export interface PowerPartRow {
  entry_id: number;
  ord: number;
  depth: number;
  label: string;
  text: string;
  text_html: string | null;
}

export interface FeatRow {
  entry_id: number;
  tier: string | null;
  tier_zh: string | null;
  prerequisite: string | null;
  benefit: string | null;
}

export interface EquipmentRow {
  entry_id: number;
  item_level: string | null;
  item_category: string | null;
  item_suitable: string | null;
  rarity: string | null;
  rarity_en: string | null;
  level_label: string | null;
  flavor_text: string | null;
  enhancement: string | null;
  critical: string | null;
  details_html: string | null;
}

export interface ItemBlockRow {
  entry_id: number;
  ord: number;
  kind: "property" | "power";
  name: string | null;
  usage: string | null;
  action: string | null;
  keywords: string;
  text: string;
}

export interface MonsterRow {
  entry_id: number;
  section: string | null;
  book: string | null;
  book_matched: number;
  level: number | null;
  rank: string | null;
  role: string | null;
  origin: string | null;
  creature_type: string | null;
  creature_group: string | null;
  xp: number | null;
  hp: number | null;
  bloodied: number | null;
  ac: number | null;
  fortitude: number | null;
  reflex: number | null;
  will: number | null;
  initiative: string | null;
  perception: string | null;
  speed: string | null;
  alignment: string | null;
  extractor_version: string | null;
}

export interface MonsterPowerRow {
  id: number;
  entry_id: number;
  ord: number;
  kind: "power" | "trait";
  name: string;
  group_name: string | null;
  usage: string | null;
  text: string;
  attack_bonus: string | null;
  defense: string | null;
}

export interface RuleMetaRow {
  entry_id: number;
  kind: string;
  chapter_id: number | null;
  section_id: number | null;
  ord: number;
  term_category: string | null;
}

/** 一条词条的完整展开（entry + 卫星表 + wikitext 结构）。 */
export interface EntryDetail extends EntryRow {
  fields: Record<string, string>;
  tags: string[];
  headings: { depth: number; text: string }[];
  links: { target_title: string; alias: string | null; target_entry_id: number | null }[];
  transclusions: { target_title: string; target_entry_id: number | null }[];
  macros: string[];
  power?: PowerRow & { parts: PowerPartRow[]; keywordList: string[] };
  feat?: FeatRow & { prerequisites: { ord: number; text: string; target_entry_id: number | null; target_title: string | null }[] };
  equipment?: EquipmentRow & { levels: { level: number; suffix: string | null }[]; blocks: ItemBlockRow[] };
  race?: { size: string | null; speed: string | null; vision: string | null; ability_one: string | null; ability_two: string | null };
  classInfo?: { role: string | null; role_en: string | null; power_source: string | null; power_source_en: string | null; hybrid: string | null };
  ritual?: { level: number | null; key_skill: string | null; category: string | null; facts: { key: string; value: string }[] };
  gear?: { item_category: string | null; group_name: string | null; cost: string | null; cost_cp: number | null; weight: string | null; weight_lb: number | null; is_kit: number; contents: string[] };
  monster?: MonsterRow & {
    abilities: Record<string, { score: number | null; modifier: string | null }>;
    skills: { name: string; bonus: string | null }[];
    languages: string[];
    equipment: string[];
    notes: { kind: string; text: string }[];
    powers: Array<MonsterPowerRow & { parts: { label: string; text: string }[]; keywords: string[] }>;
  };
  rule?: RuleMetaRow;
  related: Array<{ kind: string; entry_id: number; uid: string; name: string; category: string }>;
}

export interface SearchHit {
  id: number;
  uid: string;
  category: string;
  name: string;
  name_en: string | null;
  snippet: string;
  score: number;
}

export interface BookRow {
  code: string;
  title: string | null;
  kind: string | null;
  entries: number;
}

export interface Stats {
  schemaVersion: number;
  builtAt: string;
  entries: number;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
  relations: number;
}

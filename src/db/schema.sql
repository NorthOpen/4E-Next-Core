-- ===========================================================================
-- 4e-next-core 数据库 schema（SQLite）
--
-- 设计约定（改动前请先读 docs/schema.md 的同名章节）：
--   1. 三条来源（4e Wiki / 万律 / 怪物手册）统一到 entry 一张主表，靠 category 区分语义；
--   2. entry.source_text 永远是权威原文，任何结构化字段都能回溯，抽不出来不算错；
--   3. 类别专属字段放卫星表，主表只留跨类别通用的列；
--   4. wiki 的原始字段进 entry_field（EAV），保证「无损」——但**已经升格成主表列的**
--      与**全表单一常量**的字段不再重复存（详见 docs/schema.md「无损的边界」）；
--   5. 引用关系落成 entry_link（可解析的就落 target_entry_id）与 relation（统一图边）；
--   6. 中文检索走 entry_fts：索引侧逐字切分，查询侧短语匹配，等价于连续子串；
--   7. 只有主键的「子表 / 关联表」一律 WITHOUT ROWID —— 省掉与数据等大的那份 PK 索引。
-- ===========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 元信息与来源
-- ---------------------------------------------------------------------------

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 构建历史：每次 db 构建追加一行，便于下游判断拿到的是哪一版
CREATE TABLE build (
  id             INTEGER PRIMARY KEY,
  built_at       TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  entries        INTEGER NOT NULL,
  stats          TEXT    NOT NULL          -- JSON: { category: count }
);

-- 数据源指纹
CREATE TABLE source (
  id        INTEGER PRIMARY KEY,
  key       TEXT    NOT NULL UNIQUE,       -- wiki | rules | monsters
  title     TEXT    NOT NULL,
  path      TEXT    NOT NULL,              -- 仓库相对路径
  sha256    TEXT    NOT NULL,
  bytes     INTEGER NOT NULL,
  modified  TEXT,
  built_at  TEXT    NOT NULL,
  detail    TEXT                           -- JSON，来源自身的结构信息
);

-- 书籍/刊物维度。title 只为确认过的代码填写，未收录时留空而不是猜。
CREATE TABLE book (
  code  TEXT PRIMARY KEY,                  -- PH / MP2 / Dragon / MM1 …
  title TEXT,
  kind  TEXT                               -- core | supplement | magazine | monster | other
);

-- ---------------------------------------------------------------------------
-- 词条主表
-- ---------------------------------------------------------------------------

CREATE TABLE entry (
  id          INTEGER PRIMARY KEY,
  uid         TEXT    NOT NULL UNIQUE,     -- 稳定全局 id：<category>/<title>
  source_key  TEXT    NOT NULL REFERENCES source(key) ON DELETE CASCADE,
  category    TEXT    NOT NULL,            -- race|class|…|monster|rule
  title       TEXT    NOT NULL,            -- 来源里的原始标题
  name        TEXT    NOT NULL,            -- 中文名
  name_en     TEXT,                        -- 英文名
  content_type TEXT,                       -- tiddler type（wiki 专用）
  source_book TEXT,                        -- 书籍代码
  magazine    TEXT,                        -- 杂志期号
  source_text TEXT    NOT NULL,            -- 权威原文（唯一的文本来源）
  content_hash TEXT   NOT NULL,            -- sha256(source_text)，增量同步依据
  created     TEXT,
  modified    TEXT,
  modifier    TEXT,
  revision    TEXT,
  ord         INTEGER NOT NULL DEFAULT 0,  -- 类别内顺序（按名称排序）
  is_derived  INTEGER NOT NULL DEFAULT 0   -- 1 = 由其它词条派生（如冒险装备）
);

CREATE INDEX idx_entry_category ON entry(category, ord);
CREATE INDEX idx_entry_book     ON entry(source_book);
CREATE INDEX idx_entry_name     ON entry(name);
CREATE INDEX idx_entry_name_en  ON entry(name_en);

-- 无损 EAV：wiki tiddler 的全部原始字段
CREATE TABLE entry_field (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  key      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  PRIMARY KEY (entry_id, key)
) WITHOUT ROWID;
CREATE INDEX idx_entry_field_key ON entry_field(key);

-- 标签
CREATE TABLE tag (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE entry_tag (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tag(id)    ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX idx_entry_tag_tag ON entry_tag(tag_id);

-- 标题层级
CREATE TABLE entry_heading (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  depth    INTEGER NOT NULL,
  text     TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;

-- wikitext 链接；能解析到本库词条就填 target_entry_id
CREATE TABLE entry_link (
  id              INTEGER PRIMARY KEY,
  entry_id        INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  target_title    TEXT    NOT NULL,
  alias           TEXT,
  target_entry_id INTEGER REFERENCES entry(id) ON DELETE SET NULL
);
CREATE INDEX idx_entry_link_from ON entry_link(entry_id);
CREATE INDEX idx_entry_link_to   ON entry_link(target_entry_id);

-- 转写（{{词条}}）
CREATE TABLE entry_transclusion (
  entry_id        INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  target_title    TEXT    NOT NULL,
  target_entry_id INTEGER REFERENCES entry(id) ON DELETE SET NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;
CREATE INDEX idx_entry_transclusion_to ON entry_transclusion(target_entry_id);

-- 宏调用
CREATE TABLE entry_macro (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;

-- 译名词典：4e Wiki 的「术语表」tiddler 里 `英文: 中文` 逐行映射，一张表拆开
CREATE TABLE glossary_term (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  en       TEXT    NOT NULL,
  zh       TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;
CREATE INDEX idx_glossary_en ON glossary_term(en);
CREATE INDEX idx_glossary_zh ON glossary_term(zh);

-- ---------------------------------------------------------------------------
-- 威能（8939 条）
-- ---------------------------------------------------------------------------

CREATE TABLE power (
  entry_id        INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  level           INTEGER,
  usage           TEXT,        -- at-will | encounter | daily | other
  usage_zh        TEXT,        -- 随意 | 遭遇 | 每日
  action_type     TEXT,        -- 标准动作 / 次要动作 / …
  power_type      TEXT,        -- 攻击 | 辅助 | 特性 | 种族威能 …
  power_kind      TEXT,        -- attack | utility | feature | racial | feat | item-set
  granted_by      TEXT,        -- 授予者原文（职业/典范/专长名）
  grantor_entry_id INTEGER REFERENCES entry(id) ON DELETE SET NULL,
  range           TEXT,
  keywords        TEXT,        -- 原始关键词串
  skill           TEXT,
  flavor_text     TEXT,
  has_attack      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_power_grantor ON power(grantor_entry_id);
CREATE INDEX idx_power_level   ON power(level);
CREATE INDEX idx_power_usage   ON power(usage);
CREATE INDEX idx_power_kind    ON power(power_kind);

CREATE TABLE power_keyword (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  keyword  TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;
CREATE INDEX idx_power_keyword_kw ON power_keyword(keyword);

-- details 表逐行拆解（目标/攻击/命中/效果/失手/触发/要求…，按 depth 保留嵌套攻击）
CREATE TABLE power_part (
  entry_id  INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  depth     INTEGER NOT NULL DEFAULT 0,
  label     TEXT    NOT NULL,
  text      TEXT    NOT NULL,
  text_html TEXT,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;
CREATE INDEX idx_power_part_label ON power_part(label);

-- ---------------------------------------------------------------------------
-- 专长 / 典范 / 天命 / 前提条件
-- ---------------------------------------------------------------------------

CREATE TABLE feat (
  entry_id     INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  tier         TEXT,        -- heroic | paragon | epic
  tier_zh      TEXT,        -- 英雄 | 典范 | 传奇
  prerequisite TEXT,
  benefit      TEXT
);
CREATE INDEX idx_feat_tier ON feat(tier);

-- 通用前提条件（专长/典范/天命/威能的「前提：」）
CREATE TABLE prerequisite (
  entry_id        INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  target_entry_id INTEGER REFERENCES entry(id) ON DELETE SET NULL,
  target_title    TEXT,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 物品（2618 条魔法物品 + 114 条冒险装备）
-- ---------------------------------------------------------------------------

CREATE TABLE equipment (
  entry_id      INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  item_level    TEXT,        -- 原始：「5 10 15 20 25 30」
  item_category TEXT,        -- 法器 / 武器 / 护甲 / …
  item_suitable TEXT,        -- 魔典 / 重刃 / …
  rarity        TEXT,        -- 普通 | 非普通 | 稀有
  rarity_en     TEXT,        -- common | uncommon | rare
  level_label   TEXT,        -- 「等级5+」
  flavor_text   TEXT,
  enhancement   TEXT,        -- 增强：
  critical      TEXT,        -- 重击：
  details_html  TEXT
);
CREATE INDEX idx_equipment_category ON equipment(item_category);
CREATE INDEX idx_equipment_rarity   ON equipment(rarity);
CREATE INDEX idx_equipment_suitable ON equipment(item_suitable);

-- 该物品的等级阶梯（从 <<item-level-N>> 宏与 item-level 字段还原）
CREATE TABLE item_level (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  level    INTEGER NOT NULL,
  suffix   TEXT,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;
CREATE INDEX idx_item_level_level ON item_level(level);

-- 物品的特性块与物品威能块
CREATE TABLE item_block (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  kind     TEXT    NOT NULL,   -- property | power
  name     TEXT,               -- 威能名/特性名（来源多数只给块头）
  usage    TEXT,               -- 每日/遭遇/随意/消耗
  action   TEXT,               -- 次要动作/自由动作/…
  keywords TEXT,               -- JSON 数组
  text     TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
);

CREATE TABLE gear (
  entry_id      INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  item_category TEXT,        -- 冒险装备
  group_name    TEXT,        -- 弹药 / 奥术法器 / 乐器 / 杂项
  cost          TEXT,        -- 原始价格串
  cost_cp       INTEGER,     -- 归一到铜币
  weight        TEXT,
  weight_lb     REAL,        -- 归一到磅
  is_kit        INTEGER NOT NULL DEFAULT 0,
  contents      TEXT         -- JSON 数组，仅展示用
);
CREATE INDEX idx_gear_group ON gear(group_name);

-- ---------------------------------------------------------------------------
-- 种族 / 职业 / 仪式
-- ---------------------------------------------------------------------------

CREATE TABLE race (
  entry_id     INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  size         TEXT,
  speed        TEXT,
  vision       TEXT,
  ability_one  TEXT,
  ability_two  TEXT
);

CREATE TABLE class (
  entry_id        INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  role            TEXT,       -- 打击者 | 领导者 | 控制者 | 防御者
  role_en         TEXT,       -- striker | leader | controller | defender
  power_source    TEXT,       -- 奥术 | 神术 | 原力 | 武术 | 灵能 | 影能
  power_source_en TEXT,
  hybrid          TEXT
);

CREATE TABLE ritual (
  entry_id INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  level    INTEGER,
  key_skill TEXT,
  category TEXT
);
CREATE INDEX idx_ritual_level ON ritual(level);

CREATE TABLE ritual_fact (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  key      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  PRIMARY KEY (entry_id, key)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 怪物（927 条，来自怪物手册 xlsx）
-- ---------------------------------------------------------------------------

CREATE TABLE monster (
  entry_id      INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  section       TEXT,
  book          TEXT,        -- MM1 | MM2 | MM3
  book_matched  INTEGER NOT NULL DEFAULT 1,
  level         INTEGER,
  rank          TEXT,        -- 杂兵 / 精英 / 强者 / 头目 / 精英（头目）…（标准怪没有这个标记）
  role          TEXT,        -- 护卫 / 游击 / 蛮战 / 控制 / 远程 / 伏击
  origin        TEXT,        -- 星界 / 自然 / 幽暗 …
  creature_type TEXT,        -- 类人生物（天使）
  creature_group TEXT,       -- 神使
  xp            INTEGER,
  hp            INTEGER,
  bloodied      INTEGER,
  ac            INTEGER,
  fortitude     INTEGER,
  reflex        INTEGER,
  will          INTEGER,
  initiative    TEXT,
  perception    TEXT,
  speed         TEXT,
  alignment     TEXT,
  extractor_version TEXT
);
CREATE INDEX idx_monster_level  ON monster(level);
CREATE INDEX idx_monster_rank   ON monster(rank);
CREATE INDEX idx_monster_role   ON monster(role);
CREATE INDEX idx_monster_origin ON monster(origin);
CREATE INDEX idx_monster_book   ON monster(book);

CREATE TABLE monster_ability (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ability  TEXT    NOT NULL,  -- 力量/体质/敏捷/智力/感知/魅力
  score    INTEGER,
  modifier TEXT,
  PRIMARY KEY (entry_id, ability)
) WITHOUT ROWID;

CREATE TABLE monster_skill (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  bonus    TEXT,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;

CREATE TABLE monster_language (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  language TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;

CREATE TABLE monster_equipment (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  name     TEXT    NOT NULL,
  PRIMARY KEY (entry_id, ord)
) WITHOUT ROWID;

-- 感官 / 免疫 / 抗性 / 易伤，统一成 notes，靠 kind 区分
CREATE TABLE monster_defense_note (
  entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  kind     TEXT    NOT NULL,  -- sense | immune | resist | vulnerable
  ord      INTEGER NOT NULL,
  text     TEXT    NOT NULL,
  PRIMARY KEY (entry_id, kind, ord)
) WITHOUT ROWID;

CREATE TABLE monster_power (
  id        INTEGER PRIMARY KEY,
  entry_id  INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL,
  kind      TEXT    NOT NULL,  -- power | trait
  name      TEXT    NOT NULL,
  group_name TEXT,             -- 标准动作 / 移动动作 / 次要动作 / 自由动作 / 触发动作 / 特性
  usage     TEXT,              -- 随意 / 遭遇 / 每日 / 充能5,6 …
  text      TEXT    NOT NULL,
  attack_bonus TEXT,           -- 从「攻击：… +19vs.AC」尽力抽出
  defense   TEXT               -- AC / 强韧 / 反射 / 意志
);
CREATE INDEX idx_monster_power_entry ON monster_power(entry_id);
CREATE INDEX idx_monster_power_kind  ON monster_power(kind);

CREATE TABLE monster_power_part (
  monster_power_id INTEGER NOT NULL REFERENCES monster_power(id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  label            TEXT    NOT NULL,
  text             TEXT    NOT NULL,
  PRIMARY KEY (monster_power_id, ord)
) WITHOUT ROWID;

CREATE TABLE monster_power_keyword (
  monster_power_id INTEGER NOT NULL REFERENCES monster_power(id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  keyword          TEXT    NOT NULL,
  PRIMARY KEY (monster_power_id, ord)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- 万律（687 条）
-- ---------------------------------------------------------------------------

CREATE TABLE rule_chapter (
  id    INTEGER PRIMARY KEY,
  title TEXT    NOT NULL UNIQUE,
  ord   INTEGER NOT NULL,
  intro TEXT
);

CREATE TABLE rule_section (
  id         INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES rule_chapter(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  ord        INTEGER NOT NULL
);
CREATE INDEX idx_rule_section_chapter ON rule_section(chapter_id);

CREATE TABLE rule_meta (
  entry_id      INTEGER PRIMARY KEY REFERENCES entry(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,  -- rule|sidebar|power|item|feat|disease|glossary|faq
  chapter_id    INTEGER REFERENCES rule_chapter(id) ON DELETE SET NULL,
  section_id    INTEGER REFERENCES rule_section(id) ON DELETE SET NULL,
  ord           INTEGER NOT NULL,
  term_category TEXT               -- 术语表条目：关键字/状态/…
);
CREATE INDEX idx_rule_kind    ON rule_meta(kind);
CREATE INDEX idx_rule_chapter ON rule_meta(chapter_id);

-- ---------------------------------------------------------------------------
-- 统一关系图
-- ---------------------------------------------------------------------------

-- 把可解析的边统一到一张表，下游做「图」查询时不必自己 union 五张表。
CREATE TABLE relation (
  id            INTEGER PRIMARY KEY,
  from_entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  to_entry_id   INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,  -- link | transclusion | grantor | prerequisite | member-of
  ord           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_relation_from ON relation(from_entry_id, kind);
CREATE INDEX idx_relation_to   ON relation(to_entry_id, kind);

-- ---------------------------------------------------------------------------
-- 全文检索
-- ---------------------------------------------------------------------------

-- 索引侧文本已逐字切分（见 src/lib/text.ts splitForIndex）：
--   「火球术」→「火 球 术」，查询侧用短语 "火 球 术" 即得到连续子串语义。
-- 保留列内容（非 contentless）是为了能用 snippet()/highlight() 出摘要。
CREATE VIRTUAL TABLE entry_fts USING fts5(
  name,
  name_en,
  body,
  keywords,
  tokenize = 'unicode61 remove_diacritics 0'
);

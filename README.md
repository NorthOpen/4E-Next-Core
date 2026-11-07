# 4E NEXT CORE

D&D 4E 中文数据的一个**可直接接入的 SQLite 数据库**：17898 条词条、40 张表（含 1 张 FTS5 全文索引虚表）、关系图，一个文件装完。

不需要服务端、不需要安装运行时、不需要构建。任何语言的 SQLite 驱动都能开它。

```
4e-next-core/
├── 4e-next-core.db      ← 数据库本体（60.6 MB），你需要的就是它
├── src/                 ← 查询接口（零依赖）+ 数据管线（可重建/更新数据库）
│   ├── api/index.ts     查询层：WikiDb 类
│   ├── schema/db.ts     行类型（纯 interface，供 TS 补全）
│   ├── db/schema.sql    建表语句（唯一的表结构事实来源）
│   ├── db/              build / satellites / resolve / diff / verify
│   ├── etl/             抽取 → 分类 → 规范化 → 万律 → 怪物
│   ├── lib/             文本归一化、HTML 拆解、TiddlyWiki / XLSX 读取
│   └── cli.ts           命令行
├── package.json
└── LICENSE              MPL-2.0
```

只要 **Node ≥ 24**（会用内置 `node:sqlite`）。不装任何包也能查询。

---

## 1. 三十秒上手

### SQLite 命令行

```bash
sqlite3 4e-next-core.db "SELECT name, level FROM entry e JOIN power p ON p.entry_id=e.id WHERE p.level >= 20 LIMIT 5;"
```

### Python（标准库，零安装）

```python
import sqlite3
con = sqlite3.connect("4e-next-core.db")
con.row_factory = sqlite3.Row

for row in con.execute("""
    SELECT e.name, p.level, p.usage_zh
      FROM power p JOIN entry e ON e.id = p.entry_id
     WHERE p.grantor_entry_id = (SELECT id FROM entry WHERE uid = 'class/圣武士 Paladin')
     ORDER BY p.level
"""):
    print(row["level"], row["name"], row["usage_zh"])
```

### Node（内置 `node:sqlite`，零依赖）

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("4e-next-core.db", { readOnly: true });
const rows = db.prepare("SELECT name, level FROM power p JOIN entry e ON e.id=p.entry_id WHERE p.level >= 20").all();
```

### 项目自带的查询接口（TypeScript，推荐）

```ts
import { openDb } from "./src/api/index.ts";

const db = openDb();                     // 默认读同目录的 4e-next-core.db
const hits = db.search("火球", { limit: 5 });
const ball = db.entry("power/火球术 Fireball");

ball?.power?.parts.forEach((p) => console.log(p.label, p.text));
db.close();
```

> 本仓库**不是** npm 包：Node 的类型剥离不支持 `node_modules` 里的 `.ts`。
> 用法是把 `src/api/index.ts` + `src/schema/db.ts` 两个文件拷进你的项目（它们只 import Node 内置模块）。
> 需要 npm 包形态就自己编一份：`npx tsc src/api/index.ts src/schema/db.ts --outDir dist --declaration`。

命令行也能查，不用写代码：

```bash
node src/cli.ts query search "火球"
node src/cli.ts query get "power/火球术 Fireball"
node src/cli.ts query sql "SELECT category, COUNT(*) n FROM entry GROUP BY category ORDER BY n DESC"
node src/cli.ts verify        # 自检：完整性 / 对账 / 覆盖率 / 检索
```

---

## 2. 查询接口（`src/api/index.ts`）

`WikiDb` 全部是同步方法（`node:sqlite` 是同步 API），返回类型见 `src/schema/db.ts`。

| 方法 | 说明 |
| --- | --- |
| `new WikiDb(file?)` / `openDb(file?)` | 打开数据库（只读）。默认 `./4e-next-core.db` |
| `.close()` | 关闭 |
| `.search(text, opts?)` | 全文检索；`opts`: `{ limit, offset, category, categories }`。中文按连续子串匹配，英文按前缀 |
| `.entry(uidOrId)` | 取一条完整词条：主表 + 卫星表 + 拆好的段 + 关系边 |
| `.find(name)` | 按 title / uid / 中文名找一条（返回主表行） |
| `.list(opts?)` | 列表；`opts`: `{ category, book, q, limit, offset }` |
| `.powersByGrantor(grantor)` | 某职业/典范/专长的全部威能（`entry.* + power.*` 扁平合并行） |
| `.monsters(filter?)` | 怪物筛选；`{ levelMin, levelMax, rank, role, book, origin, q, limit, offset }` |
| `.related(id, opts?)` | 关系图出入边；`{ kind, direction: "out"|"in"|"both", limit }` |
| `.books()` / `.categories()` / `.stats()` / `.meta()` | 维度与元信息 |
| `.sql(query, ...params)` | 任意 SQL，返回行数组 |

`entry()` 返回的对象（`EntryDetail`）：主表所有列 + `fields`（原始字段键值）+ `tags` + `headings` +
`links` + `transclusions` + `macros` + 类别卫星（`power` / `feat` / `equipment` / `race` / `classInfo` /
`ritual` / `gear` / `monster` / `rule`，按类别出现一个）+ `related`。

---

## 3. 数据模型

三条来源统一到 `entry` 主表，类别专属字段在卫星表，用 `entry.id` 一一对应。

```
entry ─┬─ entry_field      无损 EAV：wiki 原始字段（15.7 万行）
       ├─ entry_tag / tag  标签
       ├─ entry_heading    标题层级
       ├─ entry_link        [[链接]]（含解析结果 target_entry_id）
       ├─ entry_transclusion  {{转写}}
       ├─ entry_macro      <<宏>> 调用名
       ├─ power ─ power_part / power_keyword
       ├─ feat  ─ prerequisite
       ├─ equipment ─ item_level / item_block
       ├─ race / class / ritual(+ritual_fact) / gear
       ├─ monster ─ monster_ability / monster_skill / monster_language /
       │            monster_equipment / monster_defense_note /
       │            monster_power ─ monster_power_part / monster_power_keyword
       ├─ rule_meta ─ rule_chapter / rule_section
       └─ relation          统一关系图（link / transclusion / grantor / prerequisite）
```

### 规模

| 类别 | 条数 | 类别 | 条数 |
| --- | ---: | --- | ---: |
| 威能 `power` | 8939 | 怪物 `monster` | 927 |
| 专长 `feat` | 3202 | 万律 `rule` | 687 |
| 魔法物品 `equipment` | 2618 | 典范 `paragon-path` | 577 |
| 生物 `creature` | 267 | 仪式 `ritual` | 164 |
| 天命 `epic-destiny` | 115 | 冒险装备 `gear` | 114 |
| 职业 `class` | 77 | 种族 `race` | 54 |
| 套装/主题/领域/契约/学派/血统/败德/美德/参考/导航/词典 | 176 | **合计** | **17898** |

其它：`power_part` 32961 段、`power_keyword` 21249、`monster_power` 4382（+10524 段）、
`item_block` 5196、`prerequisite` 7761、`relation` 15519、`entry_field` 157276。

### `entry` 主表

| 列 | 说明 |
| --- | --- |
| `id` | 整数主键。**增量重建会按 `uid` 复用，跨版本稳定**；删库重导才重排 |
| `uid` | **对外稳定标识**，`<类别>/<标题>`，如 `power/火球术 Fireball` |
| `source_key` | `wiki` / `rules` / `monsters` |
| `category` | 见上表 |
| `title` / `name` / `name_en` | 原始标题 / 中文名 / 英文名 |
| `source_book` / `magazine` | 书籍代码（关联 `book.code`）/ 杂志期号 |
| `source_text` | **权威原文**（wikitext+HTML / xlsx 正文 / 万律原文） |
| `content_hash` | `sha256(source_text)`，单条内容指纹 |
| `created` / `modified` / `modifier` / `revision` | 维基修订信息 |
| `ord` | 类别内顺序（列表页直接 `ORDER BY ord`） |
| `is_derived` | `1` = 由其它词条派生（目前只有 `gear`） |

### 关键卫星表

| 表 | 关键列 |
| --- | --- |
| `power` | `level` `usage`(at-will/encounter/daily) `usage_zh` `action_type` `power_type` `power_kind` `granted_by` `grantor_entry_id` `range` `keywords` `skill` `has_attack` |
| `power_part` | `ord` `depth`(嵌套攻击层级) `label`(目标/攻击/命中/效果/失手/触发/要求…) `text` `text_html` |
| `feat` | `tier`(heroic/paragon/epic) `tier_zh` `prerequisite` `benefit` |
| `equipment` | `item_level` `item_category` `item_suitable` `rarity` `level_label` `enhancement` `critical` |
| `monster` | `level` `rank`(精英/杂兵/头目/强者) `role`(护卫/游击/蛮战/控制/远程/伏击) `origin` `creature_type` `xp` `hp` `bloodied` `ac` `fortitude` `reflex` `will` `initiative` `perception` `speed` `book` |
| `monster_power` | `kind`(power/trait) `name` `group_name`(标准动作/…) `usage` `attack_bonus` `defense` |
| `rule_meta` | `kind`(rule/glossary/faq/power/sidebar/item/feat/disease) `chapter_id` `section_id` `term_category` |

枚举值全集见 `src/db/schema.sql` 的行内注释 —— 那份 DDL 是唯一的表结构事实来源。

---

## 4. 常用查询

```sql
-- 某职业的全部威能（上游把职业拆成变体页时退回 granted_by 原文）
SELECT e.uid, e.name, p.level, p.usage_zh
  FROM power p JOIN entry e ON e.id = p.entry_id
 WHERE p.grantor_entry_id = (SELECT id FROM entry WHERE uid = 'class/圣武士 Paladin')
    OR p.granted_by = '圣武士'
 ORDER BY p.level;

-- 能直接投攻击骰的怪物威能
SELECT e.name AS monster, mp.name AS power, mp.attack_bonus, mp.defense
  FROM monster_power mp JOIN entry e ON e.id = mp.entry_id
 WHERE mp.attack_bonus IS NOT NULL AND mp.kind = 'power' LIMIT 20;

-- 20 级以上、每日频率的攻击威能
SELECT e.name, p.level FROM power p JOIN entry e ON e.id = p.entry_id
 WHERE p.level >= 20 AND p.usage = 'daily' AND p.has_attack = 1 ORDER BY p.level DESC;

-- 做遭遇：按等级段 + 战斗类型 + 职能筛怪
SELECT e.uid, e.name, m.level, m.rank, m.role, m.xp
  FROM monster m JOIN entry e ON e.id = m.entry_id
 WHERE m.level BETWEEN 10 AND 15 AND (? IS NULL OR m.rank = ?) AND (? IS NULL OR m.role = ?)
 ORDER BY m.level, m.rank;

-- 某个怪物的完整数据块
SELECT * FROM monster            WHERE entry_id = ?;
SELECT * FROM monster_ability    WHERE entry_id = ?;
SELECT * FROM monster_power      WHERE entry_id = ? ORDER BY ord;
SELECT * FROM monster_power_part WHERE monster_power_id = ? ORDER BY ord;

-- 专长的前提条件，以及能解析到的词条
SELECT pr.text, t.uid, t.name
  FROM prerequisite pr LEFT JOIN entry t ON t.id = pr.target_entry_id
 WHERE pr.entry_id = (SELECT id FROM entry WHERE uid LIKE 'feat/阿克霍西亚尖牙暴徒%');

-- 任意一条词条的出入边
SELECT r.kind, a.name AS from_name, b.name AS to_name
  FROM relation r JOIN entry a ON a.id = r.from_entry_id JOIN entry b ON b.id = r.to_entry_id
 WHERE r.from_entry_id = ? OR r.to_entry_id = ?;

-- 按书统计
SELECT b.code, b.title, COUNT(e.id) AS n FROM book b
  LEFT JOIN entry e ON e.source_book = b.code GROUP BY b.code ORDER BY n DESC;
```

---

## 5. 全文检索

`entry_fts` 是 FTS5 虚表（列 `name` / `name_en` / `body` / `keywords`，`rowid = entry.id`）。

中文的处理方式是**逐字索引 + 短语查询**：索引侧把 `火球术` 写成 `火 球 术`，
查询侧用短语 `"火 球 术"`，因此 `火球` 能命中 `火球术`、`延迟爆裂火球`，且不会误命中不相邻的字。
SQLite 自带的 `unicode61` 分词器会把一串汉字当成一个词，所以才需要这一步。

```sql
SELECT e.uid, e.name, snippet(entry_fts, 2, '<mark>', '</mark>', '…', 16) AS s
  FROM entry_fts JOIN entry e ON e.id = entry_fts.rowid
 WHERE entry_fts MATCH '"火 球"' ORDER BY bm25(entry_fts) LIMIT 10;
```

手写时注意查询串要先做同样的切分，否则搜不到。用 `db.search()` 就不用管 ——
它内部会调 `src/lib/text.ts` 的 `buildFtsQuery()` 处理切分、转义与英文前缀。

---

## 6. 稳定性约定

| 标识 | 承诺 |
| --- | --- |
| `entry.uid` | **稳定**。跨版本、跨重建都不变（除非上游改名） |
| `entry.id` | 增量重建按 `uid` 复用，老词条不变；**删库重导会重排**，长期引用请用 `uid` |
| `entry.content_hash` | 单条内容指纹，变化即「更新」 |
| `source.sha256` | 源文件指纹，用来核对「我们是不是同一版数据」 |
| `meta.schema_version` | 表结构版本；破坏性变更时递增 |

`entry.source_text` 永远是权威原文，任何结构化字段都能回溯到它。字段抽不出来时为 `NULL`，
**不会瞎填** —— 见下面的已知边界。

---

## 7. 重建与更新数据库

发行版只带数据库，不带源文件（版权不属于本项目）。要重建或跟进上游更新：

```bash
npm install                     # 只装 zod + typescript（构建期）

# 把三个源文件放回 data/：
#   data/4e Wiki.htm                   文件名含 wiki/维基 的 .htm，约 24 MB
#   data/4e Rules Compendium.htm       文件名含 rule/万律 的 .htm，约 5 MB
#   data/DnD4E-怪物手册1~3合订本.xlsx   文件名含 怪物 的 .xlsx，约 44 MB

npm run rebuild                 # = sync --force + verify，约 40 s
```

日常更新用增量：

```bash
npm run sync                    # 比对源文件指纹 → 只重跑变了的阶段 → 增量重建
```

- 没有变化时 60 ms 返回，不会白跑 24 MB 解析。
- **老词条 `id` 保持不变**，新词条接在最大号之后，删除的 id 留空不复用。
- 变更清单写在 `out/db/_changes.json`（`added` / `changed` / `removed` 三组 uid）。
- 构建是「写临时库 → 原子替换」，中途失败不会留下半个库。

管线分层（每层都落盘，出问题能定位到哪一层）：

```
data/*.htm|xlsx → out/raw/（无损）→ out/canonical/（规范 + contentHash）→ ./4e-next-core.db
```

其它命令：`npm run verify`（自检）、`npm run profile`（分布统计）、`npm run status`（产物是否齐全）、
`node src/cli.ts json`（额外导出浏览器用 JSON 包到 `out/json`）。

---

## 8. 已知边界

| 边界 | 说明 |
| --- | --- |
| 不含版权内容 | 只做结构化，不分发规则书文本；源文件需自备 |
| 689 个系统 tiddler 不入库 | CSS、图片、宏定义、`$:/` 命名空间下的配置 |
| 782 个 `meta` 类 tiddler 不入库 | 无法归类的碎片 |
| 13 条纯模板词条没有可读正文 | 变体种族页把内容全放在字段里，读 `entry_field` / `race` |
| 怪物 `rank` 只有 341 条有值 | 4E 的标准怪本来就没有「杂兵/精英」标记 |
| 5 条万律规则无章节 | 来源本身如此，`chapter_id = NULL` |
| 怪物插图只有锚点 | 425 张约 40 MB，未随库分发 |
| `book.title` 部分为 `NULL` | 只对确认过的代码填写，`HoF` / `OG` / `TPB` 等未确认 |
| 链接解析率 97.8% | 126 条链指向不存在的词条（只在表格里出现过的名字、章节标题），`target_entry_id` 为 `NULL` |
| 授予者解析率 79.8% | 1808 条威能的 `granted_by` 指向「上游不存在的职业页」（`法师` 只有五个变体页），**不猜**；原文仍在，按名称筛照样能用 |
| 没有 `creature` 卫星表 | 267 条生物是 `<div class=creature>` HTML 块，只存原文与字段 |

---

## 9. 许可与致谢

<a href="LICENSE"><img src="https://img.shields.io/badge/License-MPL 2.0-green.svg?style=flat-square" alt="License: MPL 2.0"/></a>

遵循 Mozilla Public License 2.0，条款与效力请参阅 [LICENSE](LICENSE)。

数据来源于由现任维护者风之守护维护的 [4e Wiki](https://4e-wiki.netlify.app/)、[4e 万律](https://4e-rules.netlify.app/)，
以及历代的 4e 全书维护者与所有 4e 中文译者。

本项目目标为数据整理、结构建模与检索工具建设，不涉及对《龙与地下城》四版规则内容或威世智所持版权内容的二次分发。

《龙与地下城》（DUNGEONS & DRAGONS）、DUNGEONS & DRAGONS 兼容性标志、D&D、《玩家手册》、《地下城主指南》和《怪物图鉴》是 Wizards of the Coast, Inc. 在美国和其他国家的商标。

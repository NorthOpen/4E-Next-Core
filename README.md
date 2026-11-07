# 4E NEXT CORE

D&D 4E 中文 SQLite 数据库。

```
4e-next-core/
├── 4e-next-core.db      ← 数据库本体（60.6 MB）
├── src/                 ← 查询接口 + 数据管线（重建/更新数据库）
│   ├── api/index.ts     查询层：WikiDb 类
│   ├── schema/db.ts     行类型
│   ├── db/schema.sql    建表语句
│   ├── db/              build / satellites / resolve / diff / verify
│   ├── etl/             抽取 → 分类 → 规范化 → 万律 → 怪物
│   ├── lib/             文本归一化、HTML 拆解、TiddlyWiki / XLSX 读取
│   └── cli.ts           命令行
├── package.json
└── LICENSE              MPL-2.0
```
---

## 使用示例

### SQLite 命令行

```bash
sqlite3 4e-next-core.db "SELECT name, level FROM entry e JOIN power p ON p.entry_id=e.id WHERE p.level >= 20 LIMIT 5;"
```

### Python

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

### Node

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("4e-next-core.db", { readOnly: true });
const rows = db.prepare("SELECT name, level FROM power p JOIN entry e ON e.id=p.entry_id WHERE p.level >= 20").all();
```

### TypeScript

```ts
import { openDb } from "./src/api/index.ts";

const db = openDb();                     // 默认读同目录的 4e-next-core.db
const hits = db.search("火球", { limit: 5 });
const ball = db.entry("power/火球术 Fireball");

ball?.power?.parts.forEach((p) => console.log(p.label, p.text));
db.close();
```
### CMD

```bash
node src/cli.ts query search "火球"
node src/cli.ts query get "power/火球术 Fireball"
node src/cli.ts query sql "SELECT category, COUNT(*) n FROM entry GROUP BY category ORDER BY n DESC"
node src/cli.ts verify        # 自检：完整性 / 对账 / 覆盖率 / 检索
```

## 许可与致谢

<a href="LICENSE"><img src="https://img.shields.io/badge/License-MPL 2.0-green.svg?style=flat-square" alt="License: MPL 2.0"/></a>

遵循 Mozilla Public License 2.0，条款与效力请参阅 [LICENSE](LICENSE)。

数据来源于由现任维护者风之守护维护的 [4e Wiki](https://4e-wiki.netlify.app/)、[4e 万律](https://4e-rules.netlify.app/)，
以及历代的 4e 全书维护者与所有 4e 中文译者。

本项目目标为数据整理、结构建模与检索工具建设，不涉及对《龙与地下城》四版规则内容或威世智所持版权内容的二次分发。

《龙与地下城》（DUNGEONS & DRAGONS）、DUNGEONS & DRAGONS 兼容性标志、D&D、《玩家手册》、《地下城主指南》和《怪物图鉴》是 Wizards of the Coast, Inc. 在美国和其他国家的商标。

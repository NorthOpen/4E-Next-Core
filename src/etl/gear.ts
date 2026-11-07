import { join } from "node:path";
import { readJsonl, writeJsonl } from "../lib/io.ts";
import { RAW_FILE, CANONICAL_DIR } from "../lib/paths.ts";
import type { RawTiddler } from "../schema/raw.ts";
import { parseName } from "../lib/name.ts";
import { sha256Hex } from "../lib/hash.ts";
import { CanonicalEntrySchema, type CanonicalEntry } from "../schema/canonical.ts";

/**
 * 冒险装备（adventuring gear）抽取。
 *
 * 源数据不是 `物品` 标签的 tiddler，而是 4 个 reference 词条正文里的 HTML 表格：
 * 「冒险装备1」「冒险装备2」「冒险装备3」「妖精荒野冒险装备」。
 * 分类器把它们整体归到 reference（见 classify.ts 的 REFERENCE_TITLES），
 * 因此装备条目从未进入 equipment；这里按表格逐行还原成独立条目。
 *
 * 表格结构：`物品 | 价格 | 重量`；价格与重量都为空的行是**分组标题行**
 * （弹药 / 奥术法器 / 乐器），不是商品。2 列表（物品/价格）是「饮食与住宿」，
 * 属于服务而非装备，这里整表跳过。
 *
 * 工具包（kit）按**原子商品**处理：价格与重量取包本身，内容物只做只读展示，
 * 不参与计价、不展开成散件。内容物映射为人工核对（见 KIT_CONTENTS），
 * 因为原文里是散文描述，正则猜不可靠。
 */

const DEFAULT_GROUP = "杂项";
const GEAR_ITEM_CATEGORY = "冒险装备";

/**
 * 分组成员表：源表格里的分组标题行之后并不会在回到「杂项」时再写一个标题，
 * 按「标题持续到下一个标题」推断会把蜡烛、铁链一类误挂到「奥术法器」下，
 * 因此改为显式成员表（构建期校验成员是否存在，源数据改名会被立刻发现）。
 */
const GROUP_MEMBERS: Record<string, string[]> = {
  弹药: ["箭（30支）", "矢（20支）", "弹丸（20颗）"],
  奥术法器: ["法珠", "权杖", "法杖", "魔典", "魔杖"],
  乐器: ["鼓", "长笛", "竖琴", "小号", "鲁特琴", "七弦琴"],
};

function groupOf(name: string): string {
  for (const [group, members] of Object.entries(GROUP_MEMBERS)) {
    if (members.includes(name)) return group;
  }
  return DEFAULT_GROUP;
}

/** 工具包内容物：仅用于说明展示（「包含：…」），不参与任何计算。 */
const KIT_CONTENTS: Record<string, string[]> = {
  标准的冒险者工具包: ["背包 ×1", "睡袋 ×1", "燧石与火镰 ×1", "腰包 ×1", "照明杖 ×2", "口粮 ×10 天", "麻绳 50 尺 ×1", "水袋 ×1"],
  攀爬者工具包: ["爪钩 ×1", "小锤 ×1", "岩钉 ×10"],
  江湖骗子工具包: ["铁蒺藜 ×1", "弯曲眼 ×1", "伪装工具 ×1", "赌博装备 ×1", "诈赌工具 ×1", "玻璃刀 ×1"],
  探索者工具包: ["撬棍 ×1", "铁钉 ×10", "铁镣铐 ×1", "矿工安全帽 ×1", "麻袋 ×2", "测量员装备 ×1", "十英尺长的杆子 ×1"],
  信徒工具包: ["蜡烛钟 ×2", "粉笔和石板 ×1", "外科医生工具箱 ×1", "教义书 ×1", "华服 ×1"],
  贤者工具包: ["生物故事集 ×1", "藏物服 ×1", "调查装备 ×1", "铁屑和磁石 ×1", "萤火虫罐 ×1", "文具盒 ×1"],
  旅行者工具包: ["迷彩服 ×1", "保暖衣物 ×1", "沙漠衣物 ×1", "地图袋 ×1", "信号弹药 ×5", "圈套 ×1"],
};

export const GEAR_PAGES = ["冒险装备1", "冒险装备2", "冒险装备3", "妖精荒野冒险装备"];

interface GearRow {
  page: string;
  name: string;
  nameEn?: string;
  raw: string;
  price?: string;
  weight?: string;
}

/** 名称里内嵌数量的装备（照明杖（2支）、箭（30支））保留原文，不做拆分。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** 从 tiddler 正文里按表格还原出行（已滤掉表头、分组标题与非装备表）。 */
function rowsOf(t: RawTiddler): GearRow[] {
  const out: GearRow[] = [];
  const tables = t.text.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows = (table.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []).map((tr) =>
      (tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? []).map((td) => cellText(td.replace(/^<t[dh]\b[^>]*>/i, "").replace(/<\/t[dh]>$/i, "")))
    );
    const header = rows[0] ?? [];
    // 2 列表 = 「饮食与住宿」（物品/价格），服务不是装备，整表跳过
    if (header.length < 3) continue;
    for (const cells of rows.slice(1)) {
      const [name, price, weight] = [cells[0] ?? "", cells[1] ?? "", cells[2] ?? ""];
      if (!name) continue;
      // 价格与重量都为空 = 分组标题行（弹药 / 奥术法器 / 乐器），不是商品
      if (!price && !weight) continue;
      const parsed = parseName(name);
      out.push({ page: t.title, name: parsed.name, nameEn: parsed.nameEn, raw: name, price: price || undefined, weight: weight || undefined });
    }
  }
  return out;
}

/** 价格 → 铜币整数（gp=100 / sp=10 / cp=1）。返回 undefined 表示无固定价或无法解析。 */
export function priceToCp(price?: string): number | undefined {
  if (!price) return undefined;
  const m = /([\d.]+)\s*(gp|sp|cp)/i.exec(price);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase();
  return Math.round(n * (unit === "gp" ? 100 : unit === "sp" ? 10 : 1));
}

/** 重量 → 磅（支持 1/2、1/10 这种分数写法；「—」表示可忽略 → undefined）。 */
export function weightToLb(weight?: string): number | undefined {
  if (!weight) return undefined;
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(weight);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const m = /([\d.]+)/.exec(weight);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function toEntry(row: GearRow): Record<string, unknown> {
  const kit = row.name in KIT_CONTENTS;
  const group = groupOf(row.name);
  const id = row.nameEn ? row.name + " " + row.nameEn : row.name;
  const costCp = priceToCp(row.price);
  const weightLb = weightToLb(row.weight);
  return {
    id,
    name: row.name,
    nameEn: row.nameEn,
    category: "gear",
    tags: [],
    sourceText: [row.raw, row.price ?? "", row.weight ?? ""].join(" ").trim(),
    fields: {
      "item-category": GEAR_ITEM_CATEGORY,
      "item-group": group,
      price: row.price ?? "",
      weight: row.weight ?? "",
      page: row.page,
      ...(kit ? { kit: "true" } : {}),
    },
    // 扁平计算字段（前端直接用）
    itemCategory: GEAR_ITEM_CATEGORY,
    group,
    cost: row.price,
    costCp,
    weight: row.weight,
    weightLb,
    kit,
    ...(kit ? { contents: KIT_CONTENTS[row.name] } : {}),
    wiki: { transclusions: [], links: [], macros: [], headings: [] },
    provenance: {
      page: row.page,
      contentHash: sha256Hex([row.page, group, row.raw, row.price ?? "", row.weight ?? ""].join("|")),
    },
  };
}

export interface GearRun {
  total: number;
  kits: number;
  groups: Record<string, number>;
  duplicates: string[];
  invalid: string[];
  canonical: string;
}

export function runGear(): GearRun {
  const tiddlers = readJsonl<RawTiddler>(RAW_FILE);
  const byTitle = new Map(tiddlers.map((t) => [t.title, t]));

  const rows: GearRow[] = [];
  for (const page of GEAR_PAGES) {
    const t = byTitle.get(page);
    if (!t) {
      console.warn("[gear] 缺少词条：" + page + "（跳过）");
      continue;
    }
    rows.push(...rowsOf(t));
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  const valid: CanonicalEntry[] = [];
  const invalid: string[] = [];
  const groups: Record<string, number> = {};
  let kits = 0;

  for (const row of rows) {
    const entry = toEntry(row);
    const id = entry.id as string;
    if (seen.has(id)) {
      duplicates.push(id);
      continue;
    }
    seen.add(id);

    const res = CanonicalEntrySchema.safeParse({ ...entry, schemaVersion: 1 });
    if (!res.success) {
      invalid.push(id + ": " + res.error.errors.map((e) => "[" + e.path.join(".") + "] " + e.message).join("; "));
      continue;
    }
    valid.push(res.data as CanonicalEntry);
    const g = entry.group as string;
    groups[g] = (groups[g] ?? 0) + 1;
    if (entry.kit) kits++;
  }

  // 分组成员存在性校验：源数据改名/删行时立刻暴露，而不是静默退回「杂项」
  const names = new Set(rows.map((r) => r.name));
  for (const [group, members] of Object.entries(GROUP_MEMBERS)) {
    for (const m of members) {
      if (!names.has(m)) console.warn("[gear] 分组成员在源表格中未找到：「" + group + "」" + m);
    }
  }
  for (const kitName of Object.keys(KIT_CONTENTS)) {
    if (!names.has(kitName)) console.warn("[gear] 工具包在源表格中未找到：" + kitName);
  }

  const canonicalPath = join(CANONICAL_DIR, "gear.jsonl");
  writeJsonl(canonicalPath, valid);

  // 不再另写 categories/gear.json：规范层是唯一产物；扁平数组由数据库导出（out/json）提供。

  return {
    total: valid.length,
    kits,
    groups,
    duplicates,
    invalid,
    canonical: canonicalPath,
  };
}

import {
  parseDetailRows,
  parseDivBlocks,
  parseItemTiers,
  parseLevelList,
  parsePowerHeader,
  parseSpanFacts,
  resolveSelfFields,
  splitLabeledBlock,
  type DetailRow,
  type DivBlock,
  type Fact,
} from "../lib/htmlparts.ts";
import { htmlToText, splitKeywords } from "../lib/text.ts";
import { extractLinks } from "../lib/wikitext.ts";

/**
 * 规范层 → 可入库结构的「抽取」层。
 *
 * 规范层（normalize）只做「扁平化 + 字段改名」，真正需要理解 HTML 的那部分在这里：
 * 威能的 details 表、魔法物品的特性/威能块、仪式的信息栏、前提条件里的引用。
 *
 * 原则不变：**抽不出来不算错**。每个函数都只做「有把握的部分」，剩下的原样留在
 * 源字段里；覆盖率由 audit 层报告，不在这层做兜底猜测。
 */

/** 规范层条目里我们能吃到的字段（按类别不同，全部可选）。 */
export interface FlatEntry {
  id: string;
  name: string;
  nameEn?: string;
  category: string;
  tags: string[];
  source?: string;
  magazine?: string;
  sourceText: string;
  fields: Record<string, string>;
  wiki: { transclusions: string[]; links: { target: string; alias?: string }[]; macros: string[]; headings: string[] };
  [key: string]: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /-?\d+/.exec(v);
    if (m) return Number(m[0]);
  }
  return undefined;
};

// --- 威能 ------------------------------------------------------------------

export interface PowerPart {
  ord: number;
  depth: number;
  label: string;
  text: string;
  html: string;
}

export interface PowerData {
  level?: number;
  usage?: string;
  usageZh?: string;
  actionType?: string;
  powerType?: string;
  powerKind?: string;
  grantedBy?: string;
  range?: string;
  keywords: string[];
  skill?: string;
  flavorText?: string;
  detailsHtml?: string;
  hasAttack: boolean;
  parts: PowerPart[];
}

export function enrichPower(n: FlatEntry): PowerData {
  const details = str(n.details) ?? "";
  const fields = n.fields ?? {};
  // 自引用字段先展开，拆解器才能看到真实文字
  const resolved = resolveSelfFields(details, fields);
  const rows: DetailRow[] = parseDetailRows(resolved);
  const parts: PowerPart[] = rows.map((r, i) => ({ ord: i, depth: r.depth, label: r.label, text: r.text, html: r.html }));
  return {
    level: int(n.level),
    usage: str(n.usage),
    usageZh: str(n.usageZh),
    actionType: str(n.actionType),
    powerType: str(n.powerType),
    powerKind: str(n.powerKind),
    grantedBy: str(n.grantedBy),
    range: str(n.range),
    keywords: splitKeywords(str(n.keywords)),
    skill: str(n.skill),
    flavorText: str(n.flavorText),
    detailsHtml: resolved || undefined,
    hasAttack: rows.some((r) => r.label === "攻击" || r.label === "主攻击" || r.label === "次攻击"),
    parts,
  };
}

// --- 专长 ------------------------------------------------------------------

export interface PrereqRef {
  ord: number;
  text: string;
  targetTitle?: string;
}

export interface FeatData {
  tier?: string;
  tierZh?: string;
  prerequisite?: string;
  benefit?: string;
  prereqs: PrereqRef[];
}

/**
 * 前提条件文本 → 结构化条目。
 *
 * 原文形如「战士，[[阿克霍西亚尖牙学徒|阿克霍西亚尖牙学徒 <流派初成>]]专长」：
 * 按 `，、；` 分成子句，每个子句落一行；子句里恰好一个 `[[链接]]` 时把目标名抽出来
 * 交给引用解析器，一个子句里多个链接就各自成行。这样「战士」这类纯文字门槛也留在库里，
 * 不会被「只取链接」的做法丢掉。
 */
export function extractPrereqRefs(text: string | undefined): PrereqRef[] {
  if (!text) return [];
  const clauses = text
    .split(/[，,、；;]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (clauses.length === 0) return [{ ord: 0, text }];

  const out: PrereqRef[] = [];
  for (const clause of clauses) {
    const links = extractLinks(clause);
    const clean = clause.replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, "$2").replace(/\[\[([^\[\]]+)\]\]/g, "$1");
    if (links.length <= 1) {
      out.push({ ord: out.length, text: clean, targetTitle: links[0]?.target });
    } else {
      for (const l of links) {
        out.push({ ord: out.length, text: l.alias ?? l.target, targetTitle: l.target });
      }
    }
  }
  return out;
}

export function enrichFeat(n: FlatEntry): FeatData {
  const prerequisite = str(n.prerequisite);
  return {
    tier: str(n.tier),
    tierZh: str(n.tierZh),
    prerequisite,
    benefit: str(n.benefit),
    prereqs: extractPrereqRefs(prerequisite),
  };
}

// --- 物品 ------------------------------------------------------------------

export interface ItemBlock {
  ord: number;
  kind: "property" | "power";
  name?: string;
  usage?: string;
  action?: string;
  keywords: string[];
  text: string;
}

export interface EquipmentData {
  itemLevel?: string;
  itemCategory?: string;
  itemSuitable?: string;
  rarity?: string;
  rarityEn?: string;
  levelLabel?: string;
  flavorText?: string;
  enhancement?: string;
  critical?: string;
  detailsHtml?: string;
  tiers: { level: number; suffix: string }[];
  blocks: ItemBlock[];
}

/**
 * 魔法物品的 details 是一串扁平 div：
 *   `[class=text]<b>增强：</b>…`  → 增强/重击/类别 等具名行
 *   `[bg-item]特性` + 后继 text → 特性块
 *   `[bg-item]威能✦每日（次要动作）` + 后继 text → 物品威能块
 * 块头之后、下一个块头之前的所有 text div 合并成该块的正文。
 */
export function enrichEquipment(n: FlatEntry): EquipmentData {
  const details = str(n.details) ?? "";
  const resolved = resolveSelfFields(details, n.fields ?? {});
  const blocksRaw: DivBlock[] = parseDivBlocks(resolved);

  const blocks: ItemBlock[] = [];
  let enhancement: string | undefined;
  let critical: string | undefined;
  let pending: { header: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!pending) return;
    const header = pending.header;
    const body = pending.body.join("\n").trim();
    const isPower = /^威能/.test(header);
    if (isPower) {
      const info = parsePowerHeader(header);
      blocks.push({
        ord: blocks.length,
        kind: "power",
        name: header,
        usage: info.usage,
        action: info.action,
        keywords: info.keywords,
        text: body,
      });
    } else {
      blocks.push({ ord: blocks.length, kind: "property", name: header, keywords: [], text: body });
    }
    pending = null;
  };

  for (const b of blocksRaw) {
    if (b.kind === "bg-item") {
      flush();
      pending = { header: htmlToText(b.html), body: [] };
      continue;
    }
    const labeled = splitLabeledBlock(b.html);
    if (labeled) {
      if (labeled.label === "增强") enhancement = labeled.value;
      else if (labeled.label === "重击") critical = labeled.value;
      else if (pending) pending.body.push(`${labeled.label}：${labeled.value}`);
      else if (labeled.label !== "类别") blocks.push({ ord: blocks.length, kind: "property", name: labeled.label, keywords: [], text: labeled.value });
      continue;
    }
    if (pending) pending.body.push(b.text);
  }
  flush();

  const tiersFromMacro = parseItemTiers(resolved);
  const tiers = tiersFromMacro.length > 0
    ? tiersFromMacro
    : parseLevelList(str(n.itemLevel)).map((level) => ({ level, suffix: "" }));

  return {
    itemLevel: str(n.itemLevel),
    itemCategory: str(n.itemCategory),
    itemSuitable: str(n.itemSuitable),
    rarity: str(n.rarity),
    rarityEn: str(n.rarityEn),
    levelLabel: str(n.level),
    flavorText: str(n.flavorText),
    enhancement,
    critical,
    detailsHtml: resolved || undefined,
    tiers,
    blocks,
  };
}

// --- 仪式 ------------------------------------------------------------------

export interface RitualData {
  level?: number;
  keySkill?: string;
  category?: string;
  facts: Fact[];
}

export function enrichRitual(n: FlatEntry): RitualData {
  const text = resolveSelfFields(n.sourceText ?? "", n.fields ?? {});
  const info = /<div class=ritualinfo>([\s\S]*?)<\/div>/.exec(text)?.[1] ?? "";
  const facts = parseSpanFacts(info);
  return {
    level: int(n.ritualLevel),
    keySkill: str(n.keySkill),
    category: str(n.ritualCategory),
    facts,
  };
}

// --- 冒险装备 --------------------------------------------------------------

export interface GearData {
  itemCategory?: string;
  groupName?: string;
  cost?: string;
  costCp?: number;
  weight?: string;
  weightLb?: number;
  isKit: boolean;
  contents: string[];
}

export function enrichGear(n: FlatEntry | Record<string, unknown>): GearData {
  const rec = n as Record<string, unknown>;
  const contents = Array.isArray(rec.contents) ? (rec.contents as string[]) : [];
  return {
    itemCategory: str(rec.itemCategory),
    groupName: str(rec.group),
    cost: str(rec.cost),
    costCp: typeof rec.costCp === "number" ? rec.costCp : int(rec.costCp),
    weight: str(rec.weight),
    weightLb: typeof rec.weightLb === "number" ? rec.weightLb : undefined,
    isKit: rec.kit === true || rec.kit === "true" || rec.kit === 1,
    contents,
  };
}

// --- 怪物 ------------------------------------------------------------------

/** 从「攻击：近战 1（一个生物）+19vs.AC」里抽出攻击加值与目标防御。 */
export function parseMonsterAttack(text: string): { bonus?: string; defense?: string } {
  const m = /([+\-]\d+)\s*vs\.?\s*(AC|强韧|反射|意志)/i.exec(text);
  if (!m) return {};
  return { bonus: m[1], defense: m[2].toUpperCase() === "AC" ? "AC" : m[2] };
}

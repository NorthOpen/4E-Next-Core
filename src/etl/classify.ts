import { join } from "node:path";
import { readJsonl, writeJson } from "../lib/io.ts";
import { RAW_FILE, CATEGORIES_DIR } from "../lib/paths.ts";
import type { RawTiddler } from "../schema/raw.ts";

export type Category =
  | "race" | "class" | "paragon-path" | "epic-destiny" | "feat" | "power"
  | "equipment" | "item-set" | "ritual" | "theme" | "domain" | "magic-school"
  | "pact" | "vice" | "virtue" | "bloodline" | "creature"
  | "reference" | "nav" | "dictionary" | "meta" | "unknown";

export interface Classification {
  title: string;
  category: Category;
  tags: string[];
  reason: string;
}

const TAG_TO_CATEGORY: Record<string, Category> = {
  种族: "race",
  职业: "class",
  典范: "paragon-path",
  天命: "epic-destiny",
  专长: "feat",
  威能: "power",
  物品: "equipment",
  物品套装: "item-set",
  仪式: "ritual",
  主题: "theme",
  领域: "domain",
  魔法学派: "magic-school",
  魔剑士契约: "pact",
  缚影师契约: "pact",
  败德: "vice",
  美德: "virtue",
  血统: "bloodline",
  生物: "creature",
  文章: "reference",
};

// 术语/规则条目：无结构化字段、无标签的规则说明页（人工整理）
const REFERENCE_TITLES = new Set([
  "常见缩写表", "术语表", "状态表", "角色升级表", "典范兼职", "混职规则",
  "技能威能规则", "魔法物品价值表", "仪式说明", "武术奥义说明", "专长相关规则",
  "主题规则", "消耗品规则", "奇物规则", "炼金物品规则", "另类奖励规则",
  "纹身", "套装", "神之碎片", "灵霜", "机关附件", "魔宠规则", "元素伙伴规则",
  "弹药", "盾牌", "法器", "护甲", "武器", "冒险装备1", "冒险装备2", "冒险装备3",
  "妖精荒野冒险装备", "伙伴的魔法物品", "魔宠的魔法物品", "坐骑的魔法物品", "败德",
]);

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isNav(t: RawTiddler): boolean {
  if (t.tags.includes("TableOfContents")) return true;
  const keys = Object.keys(t.fields);
  if (keys.includes("searchContent") || keys.includes("list") || keys.includes("list-after")) return true;
  if (keys.some((k) => k.startsWith("all") || k.endsWith("-list"))) return true;
  return false;
}

function cls(title: string, category: Category, tags: string[], reason: string): Classification {
  return { title, category, tags, reason };
}

export function classifyOne(t: RawTiddler): Classification {
  if (t.isSystem) return cls(t.title, "meta", t.tags, "system");
  if (IMAGE_TYPES.has(t.type)) return cls(t.title, "meta", t.tags, "type:" + t.type);
  if (t.type === "text/css") return cls(t.title, "meta", t.tags, "type:text/css");
  if (t.type === "application/x-tiddler-dictionary") {
    return cls(t.title, "dictionary", t.tags, "type:dictionary");
  }

  for (const tag of t.tags) {
    const cat = TAG_TO_CATEGORY[tag];
    if (cat) return cls(t.title, cat, t.tags, "tag:" + tag);
    if (tag === "TableOfContents") return cls(t.title, "nav", t.tags, "tag:TableOfContents");
  }

  if (t.fields["race-size"] !== undefined) return cls(t.title, "race", t.tags, "field:race-size");
  if (t.fields.role !== undefined && t.fields["power source"] !== undefined) {
    return cls(t.title, "class", t.tags, "field:role+power-source");
  }
  if (isNav(t)) return cls(t.title, "nav", t.tags, "field:nav-signals");
  if (t.fields.rarity !== undefined) return cls(t.title, "equipment", t.tags, "field:rarity");
  if (REFERENCE_TITLES.has(t.title)) return cls(t.title, "reference", t.tags, "title:reference-list");

  return cls(t.title, "meta", t.tags, "fallback");
}

export function runClassify(): Record<string, number> {
  const tiddlers = readJsonl<RawTiddler>(RAW_FILE);
  const counts: Record<string, number> = {};
  const routing: Record<string, string[]> = {};

  for (const t of tiddlers) {
    const c = classifyOne(t);
    counts[c.category] = (counts[c.category] ?? 0) + 1;
    if (
      c.category === "meta" ||
      c.category === "nav" ||
      c.category === "reference" ||
      c.category === "dictionary" ||
      c.category === "unknown"
    ) {
      (routing[c.category] ??= []).push(c.title + "  [" + c.reason + "]");
    }
  }

  writeJson(join(CATEGORIES_DIR, "_classification.json"), {
    generatedAt: new Date().toISOString(),
    total: tiddlers.length,
    counts,
    routing,
  });

  return counts;
}

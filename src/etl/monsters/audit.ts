import type { MonsterEntry } from "../../schema/monster.ts";
import type { MonsterSegmentResult } from "./segment.ts";
import type { MonsterImageAnchor, MonsterIndexRow, MonsterWorkbook } from "./extract.ts";

/**
 * 审计层：回答「这份来源被吃透了多少、哪里没对上」。
 *
 * 与玩家资源管线的 _audit.json 同一意图：抽取规则是渐进补的，所以每一轮都要能量化
 * 「覆盖率」与「对不上的地方」，而不是靠肉眼抽样。这里不抛错、不改数据，只报告。
 */

export interface MonsterCoverage {
  generatedAt: string;
  source: {
    file: string;
    sha256: string;
    bytes: number;
  };
  totals: {
    rawRows: number;
    sections: number;
    blocks: number;
    entries: number;
    valid: number;
    invalid: number;
  };
  books: Record<string, number>;
  /** 各结构化字段的抽取覆盖率（0..1） */
  fieldCoverage: Record<string, number>;
  /** 明确缺失的字段计数 */
  missing: Record<string, number>;
  powers: {
    entriesWithNoPower: number;
    totalTraits: number;
    totalPowers: number;
    totalParts: number;
    /** 只有头、正文只有一行且不含攻击加值的威能数 */
    headOnlyPowers: number;
  };
  index: {
    indexRows: number;
    blocksWithoutIndexRow: string[];
    indexRowsWithoutBlock: string[];
    /** 正文等级与总表等级不一致 */
    levelConflicts: { id: string; block: string; index: string }[];
    /** 正文与总表名称写法不同（多见于中英文逗号） */
    nameSpellingDiffs: { block: string; index: string }[];
  };
  images: {
    anchors: number;
    assigned: number;
    unmatchedRows: number[];
    entriesWithImage: number;
  };
  sections: {
    unmatched: string[];
    matched: number;
  };
  countsSheet: { level: number; sheet: number; index: number; ok: boolean }[];
  invalidEntries: { id: string; errors: string[] }[];
}

function rate(hit: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((hit / total) * 1000) / 1000;
}

/** 名称归一：去空白、统一中英文逗号、去掉尾部的英文括注（抽取时才补英文，不参与比对） */
function normName(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/[，,]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
}

export interface AuditInput {
  wb: MonsterWorkbook;
  seg: MonsterSegmentResult;
  entries: MonsterEntry[];
  imageStats: { byBlock: Map<number, MonsterImageAnchor>; unmatched: MonsterImageAnchor[] };
  invalid: { id: string; errors: string[] }[];
}

export function buildCoverage(input: AuditInput): MonsterCoverage {
  const { wb, seg, entries, imageStats, invalid } = input;

  const has = (fn: (e: MonsterEntry) => unknown): number => entries.filter((e) => {
    const v = fn(e);
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
  }).length;

  const fieldCoverage: Record<string, number> = {
    nameEn: rate(has((e) => e.nameEn), entries.length),
    level: rate(has((e) => e.level), entries.length),
    rank: rate(has((e) => e.rank), entries.length),
    role: rate(has((e) => e.role), entries.length),
    origin: rate(has((e) => e.origin), entries.length),
    creatureType: rate(has((e) => e.creatureType), entries.length),
    creatureGroup: rate(has((e) => e.creatureGroup), entries.length),
    xp: rate(has((e) => e.xp), entries.length),
    hp: rate(has((e) => e.hp), entries.length),
    bloodied: rate(has((e) => e.bloodied), entries.length),
    ac: rate(has((e) => e.ac), entries.length),
    fortitude: rate(has((e) => e.fortitude), entries.length),
    reflex: rate(has((e) => e.reflex), entries.length),
    will: rate(has((e) => e.will), entries.length),
    initiative: rate(has((e) => e.initiative), entries.length),
    perception: rate(has((e) => e.perception), entries.length),
    speed: rate(has((e) => e.speed), entries.length),
    abilities: rate(has((e) => e.abilities), entries.length),
    skills: rate(has((e) => e.skills), entries.length),
    languages: rate(has((e) => e.languages), entries.length),
    alignment: rate(has((e) => e.alignment), entries.length),
    equipment: rate(has((e) => e.equipment), entries.length),
    traits: rate(has((e) => e.traits), entries.length),
    powers: rate(has((e) => e.powers), entries.length),
    image: rate(has((e) => e.image), entries.length),
  };

  const missing = {
    level: entries.filter((e) => e.level === undefined).length,
    hp: entries.filter((e) => e.hp === undefined).length,
    ac: entries.filter((e) => e.ac === undefined).length,
    powersAndTraits: entries.filter((e) => e.powers.length + e.traits.length === 0).length,
  };

  const allPowers = entries.flatMap((e) => [...e.traits, ...e.powers]);
  const powers = {
    entriesWithNoPower: missing.powersAndTraits,
    totalTraits: entries.reduce((a, e) => a + e.traits.length, 0),
    totalPowers: entries.reduce((a, e) => a + e.powers.length, 0),
    totalParts: allPowers.reduce((a, p) => a + p.parts.length, 0),
    headOnlyPowers: allPowers.filter((p) => p.parts.filter((x) => x.label !== "类型").length === 0).length,
    suspiciousNames: allPowers.filter((p) => /[。；，,]$/.test(p.name) || p.name.length > 40).length,
  };

  // —— 与「总表」对齐的差异 ——
  const indexByNorm = new Map<string, MonsterIndexRow>();
  for (const r of wb.index) {
    const k = normName(r.name);
    if (!indexByNorm.has(k)) indexByNorm.set(k, r);
  }
  const blockNames = new Set(entries.map((e) => normName(e.name)));
  const blocksWithoutIndexRow: string[] = [];
  const levelConflicts: { id: string; block: string; index: string }[] = [];
  const nameSpellingDiffs: { block: string; index: string }[] = [];
  const usedIndex = new Set<string>();
  for (const e of entries) {
    const k = normName(e.name);
    const row = indexByNorm.get(k);
    if (!row) {
      blocksWithoutIndexRow.push(e.name);
      continue;
    }
    usedIndex.add(k);
    if (row.name !== e.name) nameSpellingDiffs.push({ block: e.name, index: row.name });
    if (row.level !== undefined && e.provenance && e.fields["总表等级"] !== undefined) {
      levelConflicts.push({ id: e.id, block: String(e.level), index: String(row.level) });
    }
  }
  const indexRowsWithoutBlock = wb.index
    .map((r) => r.name)
    .filter((n) => !blockNames.has(normName(n)));

  const countsSheet = wb.counts.map((c) => {
    const fromIndex = wb.index.filter((i) => i.level === c.level).length;
    return { level: c.level, sheet: c.count, index: fromIndex, ok: c.count === fromIndex };
  });

  return {
    generatedAt: new Date().toISOString(),
    source: { file: wb.source.file, sha256: wb.source.sha256, bytes: wb.source.bytes },
    totals: {
      rawRows: wb.rows.length,
      sections: seg.sections.length,
      blocks: seg.blocks.length,
      entries: entries.length,
      valid: entries.length - invalid.length,
      invalid: invalid.length,
    },
    books: seg.stats.books,
    fieldCoverage,
    missing,
    powers,
    index: {
      indexRows: wb.index.length,
      blocksWithoutIndexRow: [...new Set(blocksWithoutIndexRow)],
      indexRowsWithoutBlock: [...new Set(indexRowsWithoutBlock)],
      levelConflicts,
      nameSpellingDiffs,
    },
    images: {
      anchors: wb.images.length,
      assigned: imageStats.byBlock.size,
      unmatchedRows: imageStats.unmatched.map((a) => a.row),
      entriesWithImage: entries.filter((e) => e.image).length,
    },
    sections: {
      unmatched: seg.stats.unmatchedSections,
      matched: seg.stats.matchedSections,
    },
    countsSheet,
    invalidEntries: invalid,
  };
}

import type { DatabaseSync } from "node:sqlite";
import { enrichEquipment, enrichFeat, enrichGear, enrichPower, enrichRitual, parseMonsterAttack, type FlatEntry } from "../etl/enrich.ts";
import type { LoadedEntry, SatelliteResult } from "./model.ts";
import type { Resolver } from "./resolve.ts";

/** 万律章节 / 小节的 id 映射（由 build.ts 先建好章节表再传进来）。 */
export interface RuleMaps {
  chapters: Map<string, number>;
  sections: Map<string, number>;
}

/**
 * 类别卫星表：把规范层里那些「一类词条才有的字段」写进各自的表。
 *
 * 主表（entry）只放三类来源共有的列；凡是只有威能/物品/怪物才有的字段都进这里。
 * 这样下游既能「一句 entry 拿全量标题」，也能「一句 power 拿攻击段」。
 */

const USAGE_EN: Record<string, string> = { 随意: "at-will", 遭遇: "encounter", 每日: "daily" };

export function buildSatellites(
  db: DatabaseSync,
  entries: LoadedEntry[],
  resolver: Resolver,
  ruleMaps: RuleMaps,
): SatelliteResult {
  const byCategory = new Map<string, LoadedEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category);
    if (list) list.push(e);
    else byCategory.set(e.category, [e]);
  }

  const result: SatelliteResult = { grantEdges: [], prereqEdges: [] };

  const insertPower = db.prepare(
    `INSERT INTO power (entry_id, level, usage, usage_zh, action_type, power_type, power_kind, granted_by,
      grantor_entry_id, range, keywords, skill, flavor_text, has_attack)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPowerKeyword = db.prepare("INSERT OR REPLACE INTO power_keyword (entry_id, ord, keyword) VALUES (?, ?, ?)");
  const insertPowerPart = db.prepare("INSERT OR REPLACE INTO power_part (entry_id, ord, depth, label, text, text_html) VALUES (?, ?, ?, ?, ?, ?)");
  const insertFeat = db.prepare("INSERT INTO feat (entry_id, tier, tier_zh, prerequisite, benefit) VALUES (?, ?, ?, ?, ?)");
  const insertPrereq = db.prepare("INSERT OR REPLACE INTO prerequisite (entry_id, ord, text, target_entry_id, target_title) VALUES (?, ?, ?, ?, ?)");
  const insertEquipment = db.prepare(
    `INSERT INTO equipment (entry_id, item_level, item_category, item_suitable, rarity, rarity_en, level_label,
      flavor_text, enhancement, critical, details_html) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItemLevel = db.prepare("INSERT OR REPLACE INTO item_level (entry_id, ord, level, suffix) VALUES (?, ?, ?, ?)");
  const insertItemBlock = db.prepare("INSERT OR REPLACE INTO item_block (entry_id, ord, kind, name, usage, action, keywords, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertRace = db.prepare("INSERT INTO race (entry_id, size, speed, vision, ability_one, ability_two) VALUES (?, ?, ?, ?, ?, ?)");
  const insertClass = db.prepare("INSERT INTO class (entry_id, role, role_en, power_source, power_source_en, hybrid) VALUES (?, ?, ?, ?, ?, ?)");
  const insertRitual = db.prepare("INSERT INTO ritual (entry_id, level, key_skill, category) VALUES (?, ?, ?, ?)");
  const insertRitualFact = db.prepare("INSERT OR REPLACE INTO ritual_fact (entry_id, key, value) VALUES (?, ?, ?)");
  const insertGear = db.prepare("INSERT INTO gear (entry_id, item_category, group_name, cost, cost_cp, weight, weight_lb, is_kit, contents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertGlossary = db.prepare("INSERT OR REPLACE INTO glossary_term (entry_id, ord, en, zh) VALUES (?, ?, ?, ?)");

  const insertMonster = db.prepare(
    `INSERT INTO monster (entry_id, section, book, book_matched, level, rank, role, origin, creature_type, creature_group,
      xp, hp, bloodied, ac, fortitude, reflex, will, initiative, perception, speed, alignment, extractor_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAbility = db.prepare("INSERT OR REPLACE INTO monster_ability (entry_id, ability, score, modifier) VALUES (?, ?, ?, ?)");
  const insertSkill = db.prepare("INSERT OR REPLACE INTO monster_skill (entry_id, ord, name, bonus) VALUES (?, ?, ?, ?)");
  const insertLanguage = db.prepare("INSERT OR REPLACE INTO monster_language (entry_id, ord, language) VALUES (?, ?, ?)");
  const insertEquip = db.prepare("INSERT OR REPLACE INTO monster_equipment (entry_id, ord, name) VALUES (?, ?, ?)");
  const insertNote = db.prepare("INSERT OR REPLACE INTO monster_defense_note (entry_id, kind, ord, text) VALUES (?, ?, ?, ?)");
  const insertMonsterPower = db.prepare(
    "INSERT INTO monster_power (entry_id, ord, kind, name, group_name, usage, text, attack_bonus, defense) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMonsterPowerPart = db.prepare("INSERT OR REPLACE INTO monster_power_part (monster_power_id, ord, label, text) VALUES (?, ?, ?, ?)");
  const insertMonsterPowerKeyword = db.prepare("INSERT OR REPLACE INTO monster_power_keyword (monster_power_id, ord, keyword) VALUES (?, ?, ?)");

  const insertRuleMeta = db.prepare("INSERT INTO rule_meta (entry_id, kind, chapter_id, section_id, ord, term_category) VALUES (?, ?, ?, ?, ?, ?)");

  const resolveGrantor = (name: string | undefined): number | undefined => {
    if (!name) return undefined;
    return resolver.resolve(name);
  };

  // --- 威能 ---
  for (const e of byCategory.get("power") ?? []) {
    const id = e.id as number;
    const p = enrichPower(e.raw as FlatEntry);
    const usageZh = p.usageZh ?? (typeof e.raw.usageZh === "string" ? e.raw.usageZh : undefined);
    const usage = (typeof e.raw.usage === "string" ? e.raw.usage : undefined) ?? (usageZh ? USAGE_EN[usageZh] : undefined);
    const grantorId = resolveGrantor(p.grantedBy);
    if (grantorId !== undefined) result.grantEdges.push([id, grantorId]);
    insertPower.run(
      id,
      p.level ?? null,
      usage ?? null,
      usageZh ?? null,
      p.actionType ?? null,
      p.powerType ?? null,
      p.powerKind ?? null,
      p.grantedBy ?? null,
      grantorId ?? null,
      p.range ?? null,
      p.keywords.join("，") || null,
      p.skill ?? null,
      p.flavorText ?? null,
      p.hasAttack ? 1 : 0,
    );
    p.keywords.forEach((k, i) => insertPowerKeyword.run(id, i, k));
    for (const part of p.parts) insertPowerPart.run(id, part.ord, part.depth, part.label, part.text, part.html);
  }

  // --- 专长 / 典范 / 天命 ---
  for (const cat of ["feat"] as const) {
    for (const e of byCategory.get(cat) ?? []) {
      const id = e.id as number;
      const f = enrichFeat(e.raw as FlatEntry);
      insertFeat.run(id, f.tier ?? null, f.tierZh ?? null, f.prerequisite ?? null, f.benefit ?? null);
      for (const ref of f.prereqs) {
        const target = ref.targetTitle ? resolver.resolve(ref.targetTitle) : undefined;
        if (target !== undefined) result.prereqEdges.push([id, target]);
        insertPrereq.run(id, ref.ord, ref.text, target ?? null, ref.targetTitle ?? null);
      }
    }
  }
  for (const cat of ["paragon-path", "epic-destiny"] as const) {
    for (const e of byCategory.get(cat) ?? []) {
      const id = e.id as number;
      const prerequisite = typeof e.raw.prerequisite === "string" ? e.raw.prerequisite : undefined;
      const refs = enrichFeat({ ...(e.raw as FlatEntry), prerequisite }).prereqs;
      for (const ref of refs) {
        const target = ref.targetTitle ? resolver.resolve(ref.targetTitle) : undefined;
        if (target !== undefined) result.prereqEdges.push([id, target]);
        insertPrereq.run(id, ref.ord, ref.text, target ?? null, ref.targetTitle ?? null);
      }
    }
  }

  // --- 魔法物品 ---
  for (const e of byCategory.get("equipment") ?? []) {
    const id = e.id as number;
    const q = enrichEquipment(e.raw as FlatEntry);
    insertEquipment.run(
      id,
      q.itemLevel ?? null,
      q.itemCategory ?? null,
      q.itemSuitable ?? null,
      q.rarity ?? null,
      q.rarityEn ?? null,
      q.levelLabel ?? null,
      q.flavorText ?? null,
      q.enhancement ?? null,
      q.critical ?? null,
      q.detailsHtml ?? null,
    );
    q.tiers.forEach((t, i) => insertItemLevel.run(id, i, t.level, t.suffix));
    for (const b of q.blocks) {
      insertItemBlock.run(id, b.ord, b.kind, b.name ?? null, b.usage ?? null, b.action ?? null, JSON.stringify(b.keywords), b.text);
    }
  }

  // --- 种族 / 职业 / 仪式 ---
  for (const e of byCategory.get("race") ?? []) {
    const r = e.raw;
    insertRace.run(e.id as number, str(r.size), str(r.speed), str(r.vision), str(r.abilityOne), str(r.abilityTwo));
  }
  for (const e of byCategory.get("class") ?? []) {
    const r = e.raw;
    insertClass.run(e.id as number, str(r.role), str(r.roleEn), str(r.powerSource), str(r.powerSourceEn), str(r.hybrid));
  }
  for (const e of byCategory.get("ritual") ?? []) {
    const id = e.id as number;
    const r = enrichRitual(e.raw as FlatEntry);
    insertRitual.run(id, r.level ?? null, r.keySkill ?? null, r.category ?? null);
    for (const f of r.facts) insertRitualFact.run(id, f.key, f.value);
  }

  // --- 冒险装备 ---
  for (const e of byCategory.get("gear") ?? []) {
    const id = e.id as number;
    const g = enrichGear(e.raw as unknown as Record<string, unknown>);
    insertGear.run(
      id,
      g.itemCategory ?? null,
      g.groupName ?? null,
      g.cost ?? null,
      g.costCp ?? null,
      g.weight ?? null,
      g.weightLb ?? null,
      g.isKit ? 1 : 0,
      JSON.stringify(g.contents),
    );
  }

  // --- 译名词典（术语表 tiddler 的 en→zh 映射） ---
  for (const e of byCategory.get("dictionary") ?? []) {
    const terms = (e.raw as { terms?: Record<string, string> }).terms ?? {};
    let i = 0;
    for (const [en, zh] of Object.entries(terms)) insertGlossary.run(e.id as number, i++, en, zh);
  }

  // --- 怪物 ---
  for (const e of byCategory.get("monster") ?? []) {
    const id = e.id as number;
    const m = e.raw as unknown as MonsterRaw;
    insertMonster.run(
      id,
      str(m.section),
      str(m.book),
      m.bookMatched === false ? 0 : 1,
      num(m.level),
      str(m.rank),
      str(m.role),
      str(m.origin),
      str(m.creatureType),
      str(m.creatureGroup),
      num(m.xp),
      num(m.hp),
      num(m.bloodied),
      num(m.ac),
      num(m.fortitude),
      num(m.reflex),
      num(m.will),
      str(m.initiative),
      str(m.perception),
      str(m.speed),
      str(m.alignment),
      str(m.extractorVersion),
    );
    for (const [ability, v] of Object.entries(m.abilities ?? {})) {
      insertAbility.run(id, ability, num(v?.score), str(v?.mod));
    }
    (m.skills ?? []).forEach((s, i) => insertSkill.run(id, i, s.name, s.bonus ?? null));
    (m.languages ?? []).forEach((l, i) => insertLanguage.run(id, i, l));
    (m.equipment ?? []).forEach((x, i) => insertEquip.run(id, i, x));
    (m.senses ?? []).forEach((x, i) => insertNote.run(id, "sense", i, x));
    (m.immunities ?? []).forEach((x, i) => insertNote.run(id, "immune", i, x));
    (m.resistances ?? []).forEach((x, i) => insertNote.run(id, "resist", i, x));
    (m.vulnerabilities ?? []).forEach((x, i) => insertNote.run(id, "vulnerable", i, x));

    const powers = (m.powers ?? []).map((p) => ({ ...p, kind: "power" as const }));
    const traits = (m.traits ?? []).map((p) => ({ ...p, kind: "trait" as const }));
    [...traits, ...powers].forEach((p, ord) => {
      const attackPart = (p.parts ?? []).find((x) => x.label === "攻击");
      const atk = attackPart ? parseMonsterAttack(attackPart.text) : {};
      const info = insertMonsterPower.run(
        id,
        ord,
        p.kind,
        p.name,
        p.group ?? null,
        p.usage ?? null,
        p.text,
        atk.bonus ?? null,
        atk.defense ?? null,
      );
      const pid = Number(info.lastInsertRowid);
      (p.parts ?? []).forEach((x, i) => insertMonsterPowerPart.run(pid, i, x.label, x.text));
      (p.keywords ?? []).forEach((k, i) => insertMonsterPowerKeyword.run(pid, i, k));
    });
  }

  // --- 万律 ---
  for (const e of byCategory.get("rule") ?? []) {
    const r = e2rule(e.raw);
    const chapterId = r.chapter ? (ruleMaps.chapters.get(r.chapter) ?? null) : null;
    const sectionKey = r.chapter && r.section ? `${r.chapter}::${r.section}` : "";
    const sectionId = sectionKey ? (ruleMaps.sections.get(sectionKey) ?? null) : null;
    insertRuleMeta.run(e.id as number, r.kind, chapterId, sectionId, r.order, r.termCategory);
  }

  return result;
}

interface MonsterRaw {
  section?: string;
  book?: string;
  bookMatched?: boolean;
  level?: number;
  rank?: string;
  role?: string;
  origin?: string;
  creatureType?: string;
  creatureGroup?: string;
  xp?: number;
  hp?: number;
  bloodied?: number;
  ac?: number;
  fortitude?: number;
  reflex?: number;
  will?: number;
  initiative?: string;
  perception?: string;
  speed?: string;
  alignment?: string;
  extractorVersion?: string;
  abilities?: Record<string, { score?: number; mod?: string }>;
  skills?: Array<{ name: string; bonus?: string }>;
  languages?: string[];
  equipment?: string[];
  senses?: string[];
  immunities?: string[];
  resistances?: string[];
  vulnerabilities?: string[];
  powers?: Array<{ name: string; group?: string; usage?: string; text: string; keywords?: string[]; parts?: Array<{ label: string; text: string }> }>;
  traits?: Array<{ name: string; group?: string; usage?: string; text: string; keywords?: string[]; parts?: Array<{ label: string; text: string }> }>;
}

function e2rule(raw: unknown): {
  kind: string;
  chapter?: string;
  section?: string;
  order: number;
  termCategory: string | null;
} {
  const r = raw as { kind?: string; chapter?: string; section?: string; order?: number; termCategory?: string };
  return {
    kind: r.kind ?? "rule",
    chapter: r.chapter,
    section: r.section,
    order: r.order ?? 0,
    termCategory: r.termCategory ?? null,
  };
}

/** SQLite 只接受 null/number/string/bigint/Uint8Array —— undefined 会被拒，统一收敛成 null。 */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

import { writeJsonl } from "../../lib/io.ts";
import { MONSTERS_BLOCKS_DIR } from "../../lib/paths.ts";
import { join } from "node:path";
import type { MonsterRawRow, MonsterTocEntry } from "./extract.ts";

/**
 * 分块层：把「数据」表的线性行流切成「章节 → 怪物块」。
 *
 * 该表的排版是「一段一段贴上去的」：章节标题行（如 天使ANGEL）之后跟着若干怪物，
 * 每个怪物由名称行起头，后面是数值行、段头行（标准动作/特性/…）、威能头与威能正文，
 * 末尾可能有图注行与译注行，最后常有一个空行。
 *
 * 因此切块完全靠两类锚点：
 *   · 章节行 —— 单行/两行、只含中文+大写英文、且带 3 个以上连续大写字母；
 *   · 名称行 —— 第二行以体型词（微型/小型/中型/大型/超大型/巨型）开头。
 * 其余行一律归属于「当前怪物块」，不需要逐行识别，这样上游排版再有变体也不会丢内容。
 */

export interface MonsterSection {
  kind: "section";
  title: string;
  /** 规范化后的中文前缀，用于与「目录」表对齐 */
  key: string;
  book: string;
  bookMatched: boolean;
  row: number;
  monsterCount: number;
}

export interface MonsterBlock {
  kind: "monster";
  section: string;
  book: string;
  bookMatched: boolean;
  rowStart: number;
  rowEnd: number;
  /** 名称行（第一行，尾部可能带 LV/职能） */
  headerLine: string;
  /** 体型行（第二行，尾部可能带 XP） */
  subLine: string;
  /** 整块合并原文（含名称行与体型行），是规范层的权威文本 */
  text: string;
  /** 图注行原文 */
  caption?: string;
  captionRow?: number;
  /** 译注等附注 */
  notes: string[];
}

export interface MonsterPreamble {
  kind: "preamble";
  row: number;
  text: string;
}

export interface MonsterSegmentResult {
  sections: MonsterSection[];
  blocks: MonsterBlock[];
  preamble: MonsterPreamble[];
  stats: {
    sectionRows: number;
    monsterBlocks: number;
    books: Record<string, number>;
    matchedSections: number;
    unmatchedSections: string[];
  };
}

const SIZE_WORDS = ["微型", "小型", "中型", "大型", "超大型", "巨型"];
const SIZE_HEAD_RE = new RegExp("^(" + SIZE_WORDS.join("|") + ")[\\s　]");

/** 章节行允许出现的字符：中文、大写英文、数字、逗号句点冒号等少量标点 */
const SECTION_CHARS_RE = /^[\u4e00-\u9fa5A-Za-z0-9,:'’\-\.\s：]+$/;
/** 章节名里必须有的英文段落（巨蚁ANT,GIANT / 龙 DRAGON / 附录：动物 APPENDIX:ANIMALS） */
const SECTION_EN_RE = /[A-Z]{3,}/;

function splitLines(v: string): string[] {
  return v
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+$/, ""))
    .filter((s) => s.trim() !== "");
}

export function isSectionLine(s: string): boolean {
  const t = s.trim();
  if (t.length < 4 || t.length > 50) return false;
  if (!SECTION_EN_RE.test(t)) return false;
  if (!SECTION_CHARS_RE.test(t)) return false;
  // 名称行「守护天使（Angel of Protection）」带括号，排除；这也顺带排除了译注行
  if (/[（）()《》·。；！？]/.test(t)) return false;
  return true;
}

export function isMonsterHeader(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const first = lines[0].trim();
  const second = lines[1].trim();
  if (!SIZE_HEAD_RE.test(second)) return false;
  if (first.length === 0 || first.length > 160) return false;
  // 名称行不应以数值/字段关键词开头
  if (/^(HP|AC|速度|先攻|技能|阵营|力量|体质|敏捷|智力|感知|魅力|免疫|抗性|豁免|行动点)/.test(first)) return false;
  return true;
}

/** 章节名规范化：取开头连续中文（「恶魔，巴布魔DEMON,BABAU」→ 恶魔） */
export function sectionKey(s: string): string {
  const m = /^[\u4e00-\u9fa5]+/.exec(s.trim());
  if (m) return m[0];
  return s.replace(/\s+/g, "").toUpperCase();
}

/**
 * 书归属：把「数据」表里出现的章节序列与「目录」表的 MM1/MM2/MM3 三列做顺序对齐。
 * 目录里同一章节会在多本书里重复（天使ANGEL 在 MM1 与 MM2 都有），所以必须按顺序贪心推进，
 * 不能只查集合。对不上的章节（译名变体、附录动物）沿用当前书并记 bookMatched=false，
 * 由 audit 层报告，避免悄悄给错归属。
 */
/**
 * 向前看多少条目录项。窗口必须小：MM1 末尾的「动物附录」里有 鲨鱼/蜘蛛/狼 这些章节，
 * 它们在 MM2 的目录里也存在（差 65 条），窗口一大就会把附录误判成 MM2 的章节，
 * 指针一冲过头，后面整本 MM2 都会错位。20 条足以跨过「目录列了而正文缺章」的空档。
 */
const TOC_LOOKAHEAD = 20;

function alignBooks(sections: MonsterSection[], toc: MonsterTocEntry[]): void {
  const keys = toc.map((t) => sectionKey(t.text));
  let ti = 0;
  let curBook = toc.length > 0 ? toc[0].book : "MM1";
  for (const s of sections) {
    let found = -1;
    const limit = Math.min(keys.length, ti + TOC_LOOKAHEAD);
    for (let j = ti; j < limit; j++) {
      if (keys[j] === s.key) {
        found = j;
        break;
      }
    }
    if (found >= 0) {
      curBook = toc[found].book;
      ti = found + 1;
      s.book = curBook;
      s.bookMatched = true;
    } else {
      // 对不上就原地不动：目录里有条目在正文里缺章（如 MM1 目录列了 灰矮人DUERGAR、
      // 正文却没有），若这时推进指针，后面所有章节都会连锁错位。不推进才能自愈。
      s.book = curBook;
    }
  }
}

export function buildMonsterBlocks(rows: MonsterRawRow[], toc: MonsterTocEntry[]): MonsterSegmentResult {
  const sections: MonsterSection[] = [];
  const blocks: MonsterBlock[] = [];
  const preamble: MonsterPreamble[] = [];
  // 块 → 所属章节对象的直接引用。不能回头按章节标题查表：三本书里同名章节不少
  // （天使ANGEL 在 MM1 与 MM2 都有），查表会把前面的块并到后面那本去。
  const sectionOf = new Map<MonsterBlock, MonsterSection>();
  let curSection: MonsterSection | null = null;
  let cur: MonsterBlock | null = null;

  // 章节标题偶尔和别的内容挤在同一物理行（如「兽人ORC\n（译注：…）」），
  // 所以先把每一行按「章节行」切开，再逐块判定，否则整行会落进上一个怪物的正文。
  const splitAtSections = (lines: string[]): string[][] => {
    const out: string[][] = [];
    let buf: string[] = [];
    for (const line of lines) {
      if (isSectionLine(line)) {
        if (buf.length > 0) out.push(buf);
        out.push([line]);
        buf = [];
      } else {
        buf.push(line);
      }
    }
    if (buf.length > 0) out.push(buf);
    return out;
  };
  const isNoteLine = (l: string): boolean => /译注/.test(l) || /^[（(][^）)]*[）)]$/.test(l.trim());

  const flush = (): void => {
    if (!cur) return;
    blocks.push(cur);
    cur = null;
  };
  // 章节标题之后、第一只怪物之前的散行（章节导言、整段译注）挂到该章节的第一只怪物上
  let pendingNotes: string[] = [];

  for (const row of rows) {
    const lines = splitLines(row.text);
    if (lines.length === 0) continue;

    for (const chunk of splitAtSections(lines)) {
      if (chunk.length === 1 && isSectionLine(chunk[0])) {
        flush();
        const sec: MonsterSection = {
          kind: "section",
          title: chunk[0].trim(),
          key: sectionKey(chunk[0]),
          book: curSection ? curSection.book : "MM1",
          bookMatched: false,
          row: row.row,
          monsterCount: 0,
        };
        sections.push(sec);
        curSection = sec;
        continue;
      }

      if (isMonsterHeader(chunk)) {
        flush();
        cur = {
          kind: "monster",
          section: curSection ? curSection.title : "",
          book: curSection ? curSection.book : "MM1",
          bookMatched: curSection ? curSection.bookMatched : false,
          rowStart: row.row,
          rowEnd: row.row,
          headerLine: chunk[0].trim(),
          subLine: chunk[1].trim(),
          text: chunk.join("\n"),
          notes: pendingNotes,
        };
        pendingNotes = [];
        if (curSection) {
          curSection.monsterCount++;
          sectionOf.set(cur, curSection);
        }
        continue;
      }

      if (!cur) {
        if (curSection) {
          pendingNotes.push(...chunk);
        } else {
          preamble.push({ kind: "preamble", row: row.row, text: chunk.join("\n") });
        }
        continue;
      }

      cur.rowEnd = row.row;
      cur.text = cur.text + "\n" + chunk.join("\n");
      for (const l of chunk) {
        if (/图片出自/.test(l)) {
          cur.caption = cur.caption ? cur.caption + "；" + l : l;
          cur.captionRow = row.row;
        } else if (isNoteLine(l)) {
          cur.notes.push(l);
        }
      }
    }
  }
  flush();

  alignBooks(sections, toc);

  // 章节归属是逐章节顺序推进算出来的，必须等所有章节收集完再回填到块上
  for (const b of blocks) {
    const s = sectionOf.get(b);
    if (!s) continue;
    b.book = s.book;
    b.bookMatched = s.bookMatched;
  }

  const books: Record<string, number> = {};
  for (const b of blocks) books[b.book] = (books[b.book] ?? 0) + 1;

  return {
    sections,
    blocks,
    preamble,
    stats: {
      sectionRows: sections.length,
      monsterBlocks: blocks.length,
      books,
      matchedSections: sections.filter((s) => s.bookMatched).length,
      unmatchedSections: sections.filter((s) => !s.bookMatched).map((s) => s.title),
    },
  };
}

export interface MonsterBlocksSummary {
  sections: number;
  blocks: number;
  preamble: number;
  books: Record<string, number>;
  blocksFile: string;
}

export function writeMonsterBlocks(seg: MonsterSegmentResult): MonsterBlocksSummary {
  const file = join(MONSTERS_BLOCKS_DIR, "blocks.jsonl");
  writeJsonl(file, [...seg.preamble, ...seg.sections, ...seg.blocks]);
  return {
    sections: seg.sections.length,
    blocks: seg.blocks.length,
    preamble: seg.preamble.length,
    books: seg.stats.books,
    blocksFile: file,
  };
}

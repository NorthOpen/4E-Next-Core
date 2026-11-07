import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { writeJson, writeJsonl } from "../../lib/io.ts";
import { DATA_DIR, MONSTERS_RAW_DIR } from "../../lib/paths.ts";
import { sha256File } from "../../lib/hash.ts";
import { openXlsx, type XlsxBook } from "../../lib/xlsx.ts";
import type { MonsterSource } from "../../schema/monster.ts";

/**
 * 无损层：把《DnD4E 怪物手册 1~3 合订本》xlsx 原样读出来。
 *
 * 该工作簿有四个工作表，各司其职：
 *   · 计数 —— 等级分布统计（Lv1..Lv35）；
 *   · 总表 —— 918 行怪物索引（等级/名称/类型/职能/界域/生物类别/生物种群/原文）；
 *   · 目录 —— MM1/MM2/MM3 三列章节清单，决定书的归属与阅读顺序；
 *   · 数据 —— 14802 行的大集合正文，每行是一小段（名称行/数值行/威能头/威能正文…），
 *            按行顺序线性排布，靠「名称行」切出怪物块。
 *
 * 这一层不做任何解释，只做两件事：把每个非空单元格按「列序 + 行内对齐」合并成行文本，
 * 以及记录源文件指纹。切块在 segment.ts，字段抽在 parse.ts。
 */

/** 数据表里的怪物正文默认读这一张表；找不到时按表名回退 */
const DATA_SHEET = "数据";
const INDEX_SHEET = "总表";
const TOC_SHEET = "目录";
const COUNT_SHEET = "计数";

export interface MonsterRawRow {
  sheet: string;
  row: number;
  /** 列字母 → 原文（空单元格不出现） */
  cells: Record<string, string>;
  /** 按列序合并、行内按行号对齐后的文本 */
  text: string;
}

export interface MonsterIndexRow {
  row: number;
  level?: number;
  name: string;
  rank?: string;
  role?: string;
  origin?: string;
  creatureType?: string;
  creatureGroup?: string;
  nameEn?: string;
}

export interface MonsterTocEntry {
  /** 所属书：MM1 / MM2 / MM3 */
  book: string;
  row: number;
  text: string;
}

export interface MonsterImageAnchor {
  /** 锚点所在行（1 基，与 xlsx 行号一致） */
  row: number;
  /** xlsx 内的媒体部件路径 */
  part: string;
}

export interface MonsterWorkbook {
  source: MonsterSource;
  /** 数据表首行的译稿说明 */
  preamble: string;
  rows: MonsterRawRow[];
  index: MonsterIndexRow[];
  toc: MonsterTocEntry[];
  counts: { level: number; count: number }[];
  images: MonsterImageAnchor[];
}

// ——— 行内合并 ———

/** 列字母 → 序号（A=1, Z=26, AA=27…），用于按列序拼接同一行的多个单元格 */
function colIndex(col: string): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

function splitLines(v: string): string[] {
  return v
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+$/, ""))
    .filter((s) => s.trim() !== "");
}

/**
 * 合并同一行的多个单元格。
 *
 * 「数据」表把右侧的数值（LV/XP、先攻/侦查、免疫/抗性）放在不同的列里，而列的位置
 * 随章节而变（R / Z / AF / AH / I / K …），排版时它们与 A 列是同一条视觉行的左右两半。
 * 因此合并规则是「按列序、逐行号对齐」：A 的第 1 行拼上后续列的第 1 行，第 2 行拼第 2 行，
 * 超出的行追加到末尾。这样 狄摩高根 之类的多单元格名字行也能还原成一行。
 */
export function mergeRowCells(cells: Record<string, string>): string {
  const keys = Object.keys(cells).sort((a, b) => colIndex(a) - colIndex(b));
  if (keys.length === 0) return "";
  let lines = splitLines(cells[keys[0]] ?? "");
  for (const k of keys.slice(1)) {
    const extra = splitLines(cells[k] ?? "");
    if (lines.length === 0) {
      lines = extra;
      continue;
    }
    extra.forEach((l, i) => {
      if (i < lines.length) lines[i] = lines[i] + "  " + l;
      else lines.push(l);
    });
  }
  return lines.join("\n");
}

// ——— 源文件定位 ———

/** 文件名里带「怪物」的 xlsx 优先；否则退回到目录里唯一的 xlsx。 */
export function findMonsterSource(): string | undefined {
  const dirs = [process.cwd(), DATA_DIR];
  const all: { path: string; mtime: number; hit: boolean }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".xlsx")) continue;
      if (f.startsWith("~$")) continue; // Excel 打开时的临时文件
      const p = join(dir, f);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      all.push({ path: p, mtime, hit: f.includes("怪物") });
    }
  }
  const hits = all.filter((x) => x.hit);
  const pool = hits.length > 0 ? hits : all.length === 1 ? all : [];
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0]?.path;
}

/** 溯源统一记仓库相对路径（POSIX 风格），不把本机绝对路径写进产物 */
function repoRelative(p: string): string {
  return relative(process.cwd(), p).split(sep).join("/");
}

// ——— 工作表读取 ———

function cellText(v: string | undefined): string {
  return (v ?? "").trim();
}

function num(v: string | undefined): number | undefined {
  const t = cellText(v);
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function readDataRows(book: XlsxBook, sheetName: string): MonsterRawRow[] {
  const cells = book.sheet(sheetName).rows;
  const rows: MonsterRawRow[] = [];
  for (const r of cells) {
    const clean: Record<string, string> = {};
    let any = false;
    for (const [k, v] of Object.entries(r.cells)) {
      if (v.trim() === "") continue;
      clean[k] = v;
      any = true;
    }
    if (!any) continue;
    rows.push({ sheet: sheetName, row: r.row, cells: clean, text: mergeRowCells(clean) });
  }
  rows.sort((a, b) => a.row - b.row);
  return rows;
}

function readIndex(book: XlsxBook): MonsterIndexRow[] {
  if (!book.sheetNames.includes(INDEX_SHEET)) return [];
  const out: MonsterIndexRow[] = [];
  for (const r of book.sheet(INDEX_SHEET).rows) {
    if (r.row === 1) continue;
    const name = cellText(r.cells.B);
    if (!name) continue;
    out.push({
      row: r.row,
      level: num(r.cells.A),
      name,
      rank: cellText(r.cells.C) || undefined,
      role: cellText(r.cells.D) || undefined,
      origin: cellText(r.cells.E) || undefined,
      creatureType: cellText(r.cells.F) || undefined,
      creatureGroup: cellText(r.cells.G) || undefined,
      nameEn: cellText(r.cells.H) || undefined,
    });
  }
  return out;
}

/**
 * 目录表：MMD1/MMD2/MMD3 三列分别是三本书的章节清单。
 * 必须按「列 → 行」而不是「行 → 列」展平：正文里的章节顺序是 MM1 全部 → MM2 全部 → MM3 全部，
 * 而表格是三个清单并排摆的。按行展开会把三本书交错在一起，顺序对齐随即全盘错位。
 */
function readToc(book: XlsxBook): MonsterTocEntry[] {
  if (!book.sheetNames.includes(TOC_SHEET)) return [];
  const COL_BOOKS: [string, string][] = [
    ["A", "MM1"],
    ["B", "MM2"],
    ["C", "MM3"],
  ];
  const rows = book.sheet(TOC_SHEET).rows;
  const out: MonsterTocEntry[] = [];
  for (const [col, b] of COL_BOOKS) {
    for (const r of rows) {
      if (r.row === 1) continue;
      const t = cellText(r.cells[col]);
      if (t) out.push({ book: b, row: r.row, text: t });
    }
  }
  return out;
}

function readCounts(book: XlsxBook): { level: number; count: number }[] {
  if (!book.sheetNames.includes(COUNT_SHEET)) return [];
  const out: { level: number; count: number }[] = [];
  for (const r of book.sheet(COUNT_SHEET).rows) {
    if (r.row === 1) continue;
    const m = /Lv\s*(\d+)/i.exec(cellText(r.cells.A));
    const c = num(r.cells.B);
    if (m && c !== undefined) out.push({ level: Number(m[1]), count: c });
  }
  return out;
}

/**
 * 图片锚点：数据表的 drawing 部件里，每个图片锚点记着它浮动在第几行。
 * 图注行（「守护天使，图片出自 4E《怪物图鉴》」）与锚点通常同行或相差一两行，
 * 归属判定放在 parse.ts，这里只负责把 (行号 → 媒体部件) 抽出来。
 */
function readImageAnchors(book: XlsxBook, sheetPart: string): MonsterImageAnchor[] {
  const rels = book.partRels(sheetPart);
  let drawingPart: string | undefined;
  for (const target of rels.values()) {
    if (target.startsWith("xl/drawings/") && target.endsWith(".xml")) drawingPart = target;
  }
  if (!drawingPart || !book.has(drawingPart)) return [];
  const mediaRels = book.partRels(drawingPart);
  const xml = book.readText(drawingPart);
  const out: MonsterImageAnchor[] = [];
  const re = /<xdr:(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const blk = m[0];
    const from = /<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(blk);
    if (!from) continue;
    const row = Number(from[1]) + 1;
    for (const e of blk.matchAll(/r:embed="([^"]+)"/g)) {
      const part = mediaRels.get(e[1]);
      if (part) out.push({ row, part });
    }
  }
  out.sort((a, b) => a.row - b.row || a.part.localeCompare(b.part));
  return out;
}

export function readMonsterWorkbook(path: string): MonsterWorkbook {
  const book = openXlsx(path);
  const sheetPart = book.sheetPart(DATA_SHEET) ?? book.sheetPart(book.sheetNames[book.sheetNames.length - 1]);
  const dataSheet = book.sheetPart(DATA_SHEET) ? DATA_SHEET : book.sheetNames[book.sheetNames.length - 1];
  if (!sheetPart) throw new Error("怪物手册 xlsx 里找不到工作表: " + DATA_SHEET);

  const rows = readDataRows(book, dataSheet);
  const stat = statSync(path);
  const source: MonsterSource = {
    file: repoRelative(path),
    sha256: sha256File(path),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    sheets: book.sheetNames.map((n) => ({ name: n, part: book.sheetPart(n) ?? "" })),
  };

  return {
    source,
    preamble: rows.length > 0 ? rows[0].text : "",
    rows,
    index: readIndex(book),
    toc: readToc(book),
    counts: readCounts(book),
    images: readImageAnchors(book, sheetPart),
  };
}

export interface MonsterMediaSummary {
  dir: string;
  files: number;
  bytes: number;
}

/**
 * 导出工作簿内嵌的怪物插图（xl/media/*）。
 *
 * 默认不导出：418 张图约 40MB，进仓库会显著推高体积；图与怪物的对应关系已经记在
 * 规范层的 image.part 上（指向包内部件路径），需要图片时再按需导出即可。
 */
export function exportMonsterMedia(path: string, dir: string): MonsterMediaSummary {
  const book = openXlsx(path);
  mkdirSync(dir, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const part of book.partNames()) {
    if (!part.startsWith("xl/media/")) continue;
    const buf = book.readBinary(part);
    writeFileSync(join(dir, basename(part)), buf);
    files++;
    bytes += buf.length;
  }
  return { dir, files, bytes };
}

export interface MonsterExtractSummary {
  source: MonsterSource;
  rows: number;
  indexRows: number;
  tocEntries: number;
  images: number;
  rawFile: string;
  sourceFile: string;
}

/** 无损层落盘：逐行原文 + 总表/目录/计数 + 源文件指纹 */
export function writeMonsterRaw(wb: MonsterWorkbook): MonsterExtractSummary {
  const rowsFile = join(MONSTERS_RAW_DIR, "rows.jsonl");
  const sheetsFile = join(MONSTERS_RAW_DIR, "sheets.json");
  const sourceFile = join(MONSTERS_RAW_DIR, "_source.json");
  writeJsonl(rowsFile, wb.rows);
  writeJson(sheetsFile, {
    generatedAt: new Date().toISOString(),
    source: wb.source,
    preamble: wb.preamble,
    index: wb.index,
    toc: wb.toc,
    counts: wb.counts,
    images: wb.images,
  });
  writeJson(sourceFile, { generatedAt: new Date().toISOString(), ...wb.source });
  return {
    source: wb.source,
    rows: wb.rows.length,
    indexRows: wb.index.length,
    tocEntries: wb.toc.length,
    images: wb.images.length,
    rawFile: rowsFile,
    sourceFile,
  };
}

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * 无第三方依赖的 XLSX（OOXML 表格）只读读取层。
 *
 * 为什么自己写：本项目的数据管线依赖只有 cheerio + zod，而怪物手册来源是一份 44MB 的
 * .xlsx。引入 SheetJS 会带来一个体量不小、且只用于构建期的依赖；而管线实际只需要
 * 「读取指定工作表的单元格文本」，XLSX 本身就是一个 zip 包 + 若干 XML，用 node 自带的
 * zlib 解压再按 OOXML 结构扫描即可，几十行就够，且不会随上游库变动而漂移。
 *
 * 支持范围（够用即可，刻意不做全集）：
 *   · zip：stored(0) / deflate(8)，含 zip64 扩展字段；
 *   · 单元格类型：s（共享字符串）、inlineStr、str、b、n（默认）；
 *   · 富文本 <is><r><t> 拼接、XML 实体解码。
 * 不支持：写回、样式、公式计算（只取缓存值 <v>）、加密工作簿。
 */

// ——— ZIP 容器 ———

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function parseCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 xlsx：找不到 zip 中央目录结尾记录（EOCD）");

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // zip64：EOCD 前 20 字节是 zip64 定位器
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (z64 > 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let q = p + 46 + nameLen;
      const end = q + extraLen;
      while (q + 4 <= end) {
        const id = buf.readUInt16LE(q);
        const size = buf.readUInt16LE(q + 2);
        if (id === ZIP64_EXTRA_ID) {
          let r = q + 4;
          // 顺序固定：未压缩大小、压缩大小、本地头偏移（仅在被置为 0xffffffff 时出现）
          if (buf.readUInt32LE(p + 24) === 0xffffffff) r += 8;
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(r));
            r += 8;
          }
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(buf.readBigUInt64LE(r));
          break;
        }
        q += 4 + size;
      }
    }

    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LFH_SIG) {
    throw new Error("xlsx 部件本地头损坏: " + e.name);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error("xlsx 部件使用了不支持的压缩方式(" + e.method + "): " + e.name);
}

// ——— XML 工具 ———

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;

export function decodeXmlEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(ENTITY_RE, (_m, e: string) => {
    switch (e) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default:
        return e[1] === "x" || e[1] === "X"
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

/** 取标签内属性值；要求属性名前面是空白或标签开头，避免 spans 里误匹配 s=" 。 */
function attrOf(tagHead: string, name: string): string | undefined {
  const m = new RegExp("(?:^|[\\s])" + name + "=\"([^\"]*)\"").exec(tagHead);
  return m ? decodeXmlEntities(m[1]) : undefined;
}

/** 拼接一段 XML 里所有 <t> 的文本（覆盖富文本 <r><t> 与自闭合 <t/>）。 */
function textOf(inner: string): string {
  let s = "";
  const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    if (m[1] !== undefined) s += decodeXmlEntities(m[1]);
  }
  return s;
}

function valueTag(inner: string): string {
  const m = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  return m ? decodeXmlEntities(m[1]) : "";
}

/** 相对部件路径解析（r 目标以所在目录为基准；以 / 开头视为包根绝对路径）。 */
function resolvePart(basePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const dir = basePart.includes("/") ? basePart.slice(0, basePart.lastIndexOf("/")) : "";
  const segs = (dir ? dir.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

function relsPathOf(part: string): string {
  const i = part.lastIndexOf("/");
  const dir = i < 0 ? "" : part.slice(0, i);
  const file = i < 0 ? part : part.slice(i + 1);
  return (dir ? dir + "/_rels/" : "_rels/") + file + ".rels";
}

function parseRels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<Relationship\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = attrOf(m[0], "Id");
    const target = attrOf(m[0], "Target");
    const mode = attrOf(m[0], "TargetMode");
    if (id && target && mode !== "External") out.set(id, target);
  }
  return out;
}

// ——— 工作表 ———

export interface XlsxRow {
  /** 1 基行号（与 Excel 一致） */
  row: number;
  /** 列字母 → 文本；空单元格不出现 */
  cells: Record<string, string>;
}

export interface XlsxSheet {
  name: string;
  part: string;
  rows: XlsxRow[];
}

export interface XlsxBook {
  path: string;
  sheetNames: string[];
  /** 包内全部部件路径（用于批量导出内嵌媒体等） */
  partNames(): string[];
  has(part: string): boolean;
  readBinary(part: string): Buffer;
  readText(part: string): string;
  /** 某部件的关系表：rId → Target（已相对该部件解析） */
  partRels(part: string): Map<string, string>;
  sharedStrings(): string[];
  sheet(name: string): XlsxSheet;
  /** 工作表名 → OOXML 部件路径 */
  sheetPart(name: string): string | undefined;
}

function colOf(ref: string): string {
  return ref.replace(/[0-9]+$/, "");
}

function parseCells(body: string, shared: string[]): Record<string, string> {
  const cells: Record<string, string> = {};
  let p = 0;
  for (;;) {
    const open = body.indexOf("<c", p);
    if (open < 0) break;
    const after = body[open + 2];
    if (after !== " " && after !== ">" && after !== "/") {
      p = open + 2;
      continue;
    }
    const gt = body.indexOf(">", open);
    if (gt < 0) break;
    const headRaw = body.slice(open + 2, gt);
    const selfClosing = headRaw.endsWith("/");
    const head = selfClosing ? headRaw.slice(0, -1) : headRaw;
    const ref = attrOf(head, "r");
    const type = attrOf(head, "t");

    let inner = "";
    let next: number;
    if (selfClosing) {
      next = gt + 1;
    } else {
      const close = body.indexOf("</c>", gt);
      if (close < 0) break;
      inner = body.slice(gt + 1, close);
      next = close + 4;
    }

    if (ref) {
      let v: string;
      if (type === "s") {
        const idx = Number(valueTag(inner));
        v = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : "";
      } else if (type === "inlineStr") {
        v = textOf(inner);
      } else if (type === "str") {
        v = valueTag(inner);
      } else {
        v = valueTag(inner);
      }
      if (v !== "") cells[colOf(ref)] = v;
    }
    p = next;
  }
  return cells;
}

function parseSheetXml(xml: string, shared: string[]): XlsxRow[] {
  const rows: XlsxRow[] = [];
  const start = xml.indexOf("<sheetData");
  if (start < 0) return rows;
  let p = xml.indexOf(">", start);
  if (p < 0) return rows;
  p += 1;

  for (;;) {
    // 只认真实行标签，跳过 <rowBreaks/> 之类同前缀元素
    let open = xml.indexOf("<row", p);
    while (open >= 0) {
      const c = xml[open + 4];
      if (c === " " || c === ">" || c === "/") break;
      open = xml.indexOf("<row", open + 4);
    }
    if (open < 0) break;
    const gt = xml.indexOf(">", open);
    if (gt < 0) break;
    const headRaw = xml.slice(open + 4, gt);
    const selfClosing = headRaw.endsWith("/");
    const head = selfClosing ? headRaw.slice(0, -1) : headRaw;
    const rowNo = Number(attrOf(head, "r") ?? "0");

    let body = "";
    let next: number;
    if (selfClosing) {
      next = gt + 1;
    } else {
      const close = xml.indexOf("</row>", gt);
      if (close < 0) break;
      body = xml.slice(gt + 1, close);
      next = close + 6;
    }
    rows.push({ row: rowNo, cells: parseCells(body, shared) });
    p = next;
  }
  return rows;
}

export function openXlsx(path: string): XlsxBook {
  const buf = readFileSync(path);
  const parts = new Map<string, ZipEntry>();
  for (const e of parseCentralDirectory(buf)) parts.set(e.name.replace(/^\/+/, ""), e);

  const readBinary = (part: string): Buffer => {
    const e = parts.get(part.replace(/^\/+/, ""));
    if (!e) throw new Error("xlsx 缺少部件: " + part);
    return readEntry(buf, e);
  };
  const readText = (part: string): string => readBinary(part).toString("utf8");

  const wbXml = readText("xl/workbook.xml");
  const wbRels = parseRels(readText("xl/_rels/workbook.xml.rels"));
  const sheetNames: string[] = [];
  const sheetParts = new Map<string, string>();
  {
    const re = /<sheet\b[^>]*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wbXml))) {
      const name = attrOf(m[0], "name");
      const rid = attrOf(m[0], "r:id");
      if (!name) continue;
      sheetNames.push(name);
      const target = rid ? wbRels.get(rid) : undefined;
      if (target) sheetParts.set(name, resolvePart("xl/workbook.xml", target));
    }
  }

  let sharedCache: string[] | null = null;
  const sharedStrings = (): string[] => {
    if (sharedCache) return sharedCache;
    const out: string[] = [];
    if (parts.has("xl/sharedStrings.xml")) {
      const xml = readText("xl/sharedStrings.xml");
      const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) out.push(m[1] === undefined ? "" : textOf(m[1]));
    }
    sharedCache = out;
    return out;
  };

  return {
    path,
    sheetNames,
    partNames: () => [...parts.keys()].sort(),
    has: (part) => parts.has(part.replace(/^\/+/, "")),
    readBinary,
    readText,
    partRels: (part) => {
      const relsPath = relsPathOf(part);
      if (!parts.has(relsPath)) return new Map<string, string>();
      const map = parseRels(readText(relsPath));
      const abs = new Map<string, string>();
      for (const [id, target] of map) abs.set(id, resolvePart(part, target));
      return abs;
    },
    sharedStrings,
    sheetPart: (name) => sheetParts.get(name),
    sheet: (name) => {
      const part = sheetParts.get(name);
      if (!part) throw new Error("工作簿里没有名为「" + name + "」的工作表");
      return { name, part, rows: parseSheetXml(readText(part), sharedStrings()) };
    },
  };
}

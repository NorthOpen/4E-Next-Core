import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { writeJson, writeJsonCompact } from "../lib/io.ts";
import { extractStoreTiddlers } from "../lib/store.ts";
import { DATA_DIR, RULES_DIR } from "../lib/paths.ts";
import type { RawTiddler } from "../schema/raw.ts";
import { parseName } from "../lib/name.ts";
import { extractTransclusions, extractLinks, extractHeadings, type LinkRef } from "../lib/wikitext.ts";

/**
 * 万律书（4e Rules Compendium 单文件 TW5）→ 速查词条。
 *
 * 与主维基（data/4e Wiki.htm）不同，万律书的条目是「规则正文」而非车卡数据：
 *   · 章节词条（tag=TableOfContents，目录 list 字段给出顺序）承载大纲，小节以 {{词条}} 转写引入；
 *   · 第一章等章节直接把正文写在章节词条里（以 ! 小节标题切段），需要就地切分为小节词条；
 *   · 术语表是一份「中文 [类别] english [type]：定义」的词条串，逐条拆出后才能按关键词命中；
 *   · 常见问题解答是一串 ''问题'' + 回答。
 * 产物为一份自包含 JSON（entries + chapters），供前端「万律速查」按关键词模糊检索。
 */

export type RuleKind =
  | "rule"
  | "sidebar"
  | "power"
  | "item"
  | "feat"
  | "disease"
  | "glossary"
  | "faq";

export interface RuleEntry {
  id: string;
  title: string;
  titleEn?: string;
  kind: RuleKind;
  chapter?: string;
  section?: string;
  /** 章节内阅读顺序（小到大） */
  order: number;
  tags: string[];
  /** wikitext 原文（前端按万律语法渲染） */
  text: string;
  fields: Record<string, string>;
  headings: string[];
  links: LinkRef[];
  transclusions: string[];
  source?: string;
  /** 术语表条目：类别（如 关键字/状态） */
  termCategory?: string;
}

export interface RuleChapter {
  title: string;
  order: number;
  /** 章节导言（首个 ! 小节标题之前的部分） */
  intro: string;
  sections: { title: string; entries: string[] }[];
}

export interface RulesPayload {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  total: number;
  chapters: RuleChapter[];
  entries: RuleEntry[];
}

export interface RulesSummary {
  source: string;
  total: number;
  chapters: number;
  terms: number;
  faq: number;
  output: string;
  meta: string;
}

const META_FIELDS = new Set(["created", "creator", "modified", "modifier", "title", "tags", "text", "type"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** 目录词条自身的标题（list 字段承载章节顺序，本身不是内容） */
const TOC_TIDDLER = "TableOfContents";
const GLOSSARY_TIDDLER = "术语表";
const FAQ_TIDDLER = "常见问题解答";

function isContent(t: RawTiddler): boolean {
  if (t.isSystem) return false;
  if (!t.title || !t.text.trim()) return false;
  if (t.title === TOC_TIDDLER) return false;
  if (IMAGE_TYPES.has(t.type)) return false;
  // 样式表（我的样式）与纯 CSS 词条不属于可检索内容
  if (t.tags.includes("$:/tags/Stylesheet") || t.type === "text/css") return false;
  return true;
}

function fieldsOf(t: RawTiddler): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.fields)) {
    if (META_FIELDS.has(k) || !v) continue;
    out[k] = v;
  }
  return out;
}

function kindOf(t: RawTiddler): RuleKind {
  if (/<<power-format>>/.test(t.text)) return "power";
  if (/<<item-format>>/.test(t.text)) return "item";
  if (/<<feat-format>>/.test(t.text)) return "feat";
  if (/<<disease-format>>/.test(t.text)) return "disease";
  if (t.title.startsWith("边栏-")) return "sidebar";
  return "rule";
}

/** 章节词条按「! 小节标题」切段；小节正文既可能是 {{转写}}，也可能是就地写下的正文。 */
function splitSections(text: string): { intro: string; sections: { title: string; body: string }[] } {
  const sections: { title: string; body: string[] }[] = [];
  const intro: string[] = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = /^!(?!!)\s*(.+?)\s*$/.exec(line);
    if (m) {
      cur = { title: m[1], body: [] };
      sections.push(cur);
      continue;
    }
    if (cur) cur.body.push(line);
    else intro.push(line);
  }
  return {
    intro: intro.join("\n").trim(),
    sections: sections.map((s) => ({ title: s.title, body: s.body.join("\n").trim() })),
  };
}

/** 去掉 {{!!字段}} 自引用与 {{转写}} 行之后，是否还剩下正文 */
function inlineBody(body: string): string {
  return body
    .replace(/\{\{!![^}]*\}\}/g, "")
    .replace(/^\s*\{\{[^}]+\}\}\s*$/gm, "")
    .replace(/^\s*$/gm, "")
    .trim();
}

/** 术语表：''中文 [类别] english [type]：''定义 */
interface GlossaryTerm {
  zh: string;
  en?: string;
  category?: string;
  def: string;
}

function parseGlossary(text: string): GlossaryTerm[] {
  const out: GlossaryTerm[] = [];
  const re = /''([^'\n]{1,80}?)[：:]\s*''/g;
  const marks: { start: number; end: number; head: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) marks.push({ start: m.index, end: m.index + m[0].length, head: m[1].trim() });
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const def = text.slice(marks[i].end, stop).trim();
    const head = marks[i].head;
    const cat = /\[([^\]]+)\]/.exec(head);
    const zh = head.replace(/\s*\[[^\]]+\]\s*/g, " ").replace(/[A-Za-z][A-Za-z0-9 '\-.,()]*$/, "").trim();
    const enMatch = /[A-Za-z][A-Za-z0-9 '\-.,()]*$/.exec(head.replace(/\s*\[[^\]]+\]\s*/g, " "));
    const term: GlossaryTerm = { zh: zh || head, category: cat ? cat[1] : undefined, def };
    if (enMatch) {
      const en = enMatch[0].trim();
      if (en) term.en = en;
    }
    out.push(term);
  }
  return out.filter((t) => t.zh && t.def);
}

/** 常见问题解答：''问题'' + 回答 */
function parseFaq(text: string): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = [];
  const re = /''([^']+)''/g;
  const marks: { start: number; end: number; q: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) marks.push({ start: m.index, end: m.index + m[0].length, q: m[1].trim() });
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const a = text.slice(marks[i].end, stop).trim();
    if (marks[i].q) out.push({ q: marks[i].q, a });
  }
  return out;
}

/** 维基内部模板词条标题常带 Procedure 后缀（如「魔法物品等级价格Procedure」），展示时去掉 */
function displayTitle(title: string): string {
  return title.replace(/Procedure$/, "").trim() || title;
}

function makeEntry(
  base: { id: string; title: string; kind: RuleKind; text: string; tags: string[]; fields: Record<string, string> },
): RuleEntry {
  const title = base.kind === "rule" ? displayTitle(base.title) : base.title;
  const { nameEn } = parseName(title);
  return {
    id: base.id,
    title,
    titleEn: nameEn,
    kind: base.kind,
    order: 0,
    tags: base.tags,
    text: base.text,
    fields: base.fields,
    headings: extractHeadings(base.text),
    links: extractLinks(base.text),
    transclusions: extractTransclusions(base.text),
    source: base.fields.source,
  };
}

interface Placement {
  chapter: string;
  section: string;
  order: number;
}

export function buildRules(sourcePath: string): RulesPayload {
  const html = readFileSync(sourcePath, "utf8");
  const tiddlers = extractStoreTiddlers(html).filter(isContent);
  const byTitle = new Map<string, RawTiddler>();
  for (const t of tiddlers) byTitle.set(t.title, t);

  // —— 章节顺序：目录词条的 list 字段 ——
  const toc = extractStoreTiddlers(html).find((t) => t.title === TOC_TIDDLER);
  const chapterTitles = (toc?.fields.list ?? "")
    .split("\n")
    .flatMap((chunk) => chunk.split(/\s{2,}|\s+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => byTitle.has(s));

  const entries: RuleEntry[] = [];
  const chapters: RuleChapter[] = [];
  const placement = new Map<string, Placement>();

  chapterTitles.forEach((chapterTitle, ci) => {
    const t = byTitle.get(chapterTitle);
    if (!t) return;
    const { intro, sections } = splitSections(t.text);
    const chapter: RuleChapter = { title: chapterTitle, order: ci, intro, sections: [] };
    sections.forEach((sec, si) => {
      const base = ci * 100000 + si * 1000;
      const ids: string[] = [];
      const body = sec.body;
      const inline = inlineBody(body);
      if (inline) {
        // 章节内就地书写的正文 → 切成独立小节词条
        const id = chapterTitle + " · " + sec.title;
        const inlineEntry = makeEntry({
          id,
          title: sec.title,
          kind: "rule",
          text: body,
          tags: t.tags.filter((x) => x !== "TableOfContents"),
          fields: {},
        });
        inlineEntry.chapter = chapterTitle;
        inlineEntry.section = sec.title;
        inlineEntry.order = base;
        entries.push(inlineEntry);
        ids.push(id);
        placement.set(id, { chapter: chapterTitle, section: sec.title, order: base });
      }
      let k = 1;
      for (const target of extractTransclusions(body)) {
        if (!byTitle.has(target)) continue;
        if (!placement.has(target)) {
          placement.set(target, { chapter: chapterTitle, section: sec.title, order: base + k });
        }
        if (!ids.includes(target)) ids.push(target);
        k++;
      }
      chapter.sections.push({ title: sec.title, entries: ids });
    });
    chapters.push(chapter);
  });

  // —— 词条构造：跳过章节词条本身（已在 chapters 中表达）与聚合词条（术语表/FAQ 另行拆分）——
  const chapterSet = new Set(chapterTitles);
  for (const t of tiddlers) {
    if (chapterSet.has(t.title)) continue;
    if (t.title === GLOSSARY_TIDDLER || t.title === FAQ_TIDDLER) continue;
    entries.push(
      makeEntry({
        id: t.title,
        title: t.title,
        kind: kindOf(t),
        text: t.text,
        tags: t.tags,
        fields: fieldsOf(t),
      }),
    );
  }

  // —— 术语表：逐条拆分为可检索词条 ——
  const glossaryTiddler = byTitle.get(GLOSSARY_TIDDLER);
  let termCount = 0;
  if (glossaryTiddler) {
    const seen = new Set<string>();
    for (const term of parseGlossary(glossaryTiddler.text)) {
      let id = GLOSSARY_TIDDLER + " · " + term.zh + (term.category ? "（" + term.category + "）" : "");
      while (seen.has(id)) id += "′";
      seen.add(id);
      const text = "''" + term.zh + (term.en ? " " + term.en : "") + "：''" + term.def;
      const entry = makeEntry({
        id,
        title: term.zh,
        kind: "glossary",
        text,
        tags: [],
        fields: {},
      });
      entry.titleEn = term.en;
      entry.termCategory = term.category;
      entry.chapter = GLOSSARY_TIDDLER;
      entry.section = term.category;
      entry.order = 900000 + termCount;
      termCount++;
      entries.push(entry);
    }
  }

  // —— 常见问题解答：逐条拆分为可检索词条 ——
  const faqTiddler = byTitle.get(FAQ_TIDDLER);
  let faqCount = 0;
  if (faqTiddler) {
    for (const item of parseFaq(faqTiddler.text)) {
      const id = FAQ_TIDDLER + " · " + faqCount;
      const entry = makeEntry({
        id,
        title: item.q,
        kind: "faq",
        text: "''" + item.q + "''\n\n" + item.a,
        tags: [],
        fields: {},
      });
      entry.chapter = FAQ_TIDDLER;
      entry.section = "常见问题解答";
      entry.order = 950000 + faqCount;
      faqCount++;
      entries.push(entry);
    }
  }

  // —— 归属回填：转写关系把未入目录的条目挂到引用它的条目所在章节 ——
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (let pass = 0; pass < 3; pass++) {
    for (const e of entries) {
      const own = placement.get(e.id);
      if (own) {
        e.chapter = own.chapter;
        e.section = own.section;
        e.order = own.order;
      }
    }
    for (const e of entries) {
      if (!e.chapter) continue;
      for (const target of e.transclusions) {
        const child = byId.get(target);
        if (child && !child.chapter) {
          child.chapter = e.chapter;
          child.section = e.section;
          child.order = e.order + 0.5;
        }
      }
    }
  }

  for (const e of entries) {
    if (!e.chapter) {
      e.chapter = "其他词条";
      e.order = 990000 + e.order;
    }
  }

  entries.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "zh-CN"));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: repoRelative(sourcePath),
    total: entries.length,
    chapters,
    entries,
  };
}

/** 溯源信息统一记仓库相对路径（POSIX 风格），不把本机绝对路径写进产物 */
function repoRelative(p: string): string {
  return relative(process.cwd(), p).split(sep).join("/");
}

/**
 * 万律书源文件（单文件 TW5）定位：仓库根目录与 data/ 里文件名带「rule / 万律」的 HTML，
 * 按修改时间取最新的一份——来源更新时直接放新文件即可，不需要改代码（与怪物手册同一约定）。
 * 主维基文件名带「wiki」而不带「rule」，不会被这里误取；旧名 4e-rules.html、data/4e Rules.htm
 * 以及新版下载名 4e Rules Compendium.htm 都命中该规则。
 */
export function findRulesSource(): string | undefined {
  const dirs = [process.cwd(), DATA_DIR];
  const all: { path: string; mtime: number }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const n = f.toLowerCase();
      if (!n.endsWith(".htm") && !n.endsWith(".html")) continue;
      if (!(n.includes("rule") || f.includes("万律"))) continue;
      if (n.includes("wiki") || f.includes("维基")) continue;
      const p = join(dir, f);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      all.push({ path: p, mtime });
    }
  }
  all.sort((a, b) => b.mtime - a.mtime);
  return all[0]?.path;
}

export function runRules(): RulesSummary {
  const src = findRulesSource();
  if (!src) throw new Error("未找到万律书源文件：请把文件名带 rule 的 4e Rules Compendium 单文件 HTML 放在仓库根目录或 data/ 目录");
  const payload = buildRules(src);
  const output = join(RULES_DIR, "rules.json");
  const metaPath = join(RULES_DIR, "_meta.json");
  writeJsonCompact(output, payload);
  const meta = {
    generatedAt: payload.generatedAt,
    source: repoRelative(src),
    schemaVersion: payload.schemaVersion,
    chapters: payload.chapters.length,
    total: payload.total,
    byKind: payload.entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {}),
    byChapter: payload.chapters.map((c) => ({ title: c.title, sections: c.sections.length })),
  };
  writeJson(metaPath, meta);
  return {
    source: repoRelative(src),
    total: payload.total,
    chapters: payload.chapters.length,
    terms: payload.entries.filter((e) => e.kind === "glossary").length,
    faq: payload.entries.filter((e) => e.kind === "faq").length,
    output,
    meta: metaPath,
  };
}

import { collapseSpace, decodeEntities, htmlToText, splitKeywords } from "./text.ts";

/**
 * HTML 片段 → 结构化字段的拆解器。
 *
 * 三条来源里真正「有结构但埋在 HTML 里」的内容只有三处，各自形态固定，这里一次性做掉：
 *
 *   1. 威能的 `details`：`<table class=details>` 的 `<tr><th>标签：</th><td>正文</td></tr>`；
 *      嵌套攻击（主攻击 → 次攻击）用 `&nbsp;&nbsp;` 表示层级，必须按 depth 保留。
 *   2. 魔法物品的 `details`：一串扁平的 `<div class=text>` / `<div class="bold bg-item">`，
 *      前者是正文或「增强：/重击：」行，后者是「特性」或「威能✦每日（次要动作）」块头。
 *   3. 仪式的 `<div class=ritualinfo>`：`<span>''等级：''<值></span>` 一行一项。
 *
 * 解析一律「保留原文 + 尽力抽取」：拆不出来就把整段留在 text 里，不丢数据。
 */

// --- 1. 标签表格 ------------------------------------------------------------

export interface DetailRow {
  /** 行首标签，去掉冒号与缩进（如「攻击」「命中」「效果」） */
  label: string;
  /** 嵌套层级：0 = 顶层，1 = 次攻击…（来源用 &nbsp;&nbsp; 表示） */
  depth: number;
  /** 单元格内的 HTML 原文 */
  html: string;
  /** 单元格内的纯文本（保留换行） */
  text: string;
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/**
 * 拆解 `<table class=details>` 的行。
 *
 * 用栈跟踪 `<table>` 深度，只取最外层表格的行；单元格里嵌套的表格（544 条威能有）
 * 会原样留在该单元格的 html 里，不会被误当成本表的行。
 */
export function parseDetailRows(html: string): DetailRow[] {
  const rows: DetailRow[] = [];
  const stack: string[] = [];
  let tableDepth = 0;

  interface Cell {
    kind: "th" | "td";
    start: number;
    end: number;
  }
  let cells: Cell[] = [];
  let m: RegExpExecArray | null;

  const flushRow = (): void => {
    if (cells.length === 0) return;
    const th = cells.find((c) => c.kind === "th");
    const tds = cells.filter((c) => c.kind === "td");
    if (!th && tds.length === 0) return;
    const thHtml = th ? html.slice(th.start, th.end) : "";
    const depth = Math.floor((thHtml.match(/&nbsp;/g) ?? []).length / 2);
    const label = collapseSpace(decodeEntities(htmlToText(thHtml))).replace(/[:：]\s*$/, "").replace(/^[\s:：]+/, "");
    const body = tds.map((c) => html.slice(c.start, c.end)).join("\n");
    const text = htmlToText(body);
    if (!label && !text) return;
    rows.push({ label, depth, html: body, text });
  };

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const selfClosing = m[4] === "/";
    if (!closing) {
      if (name === "table") tableDepth += 1;
      if (!selfClosing) stack.push(name);
      if (name === "tr" && tableDepth === 1) cells = [];
      if ((name === "th" || name === "td") && tableDepth === 1) {
        cells.push({ kind: name as "th" | "td", start: TAG_RE.lastIndex, end: TAG_RE.lastIndex });
      }
      continue;
    }
    // 关闭标签：先把当前单元格的截止位置钉住
    if ((name === "th" || name === "td") && tableDepth === 1) {
      const cell = cells[cells.length - 1];
      if (cell && cell.kind === name) cell.end = m.index;
    }
    if (name === "table") {
      if (tableDepth === 1) flushRow();
      tableDepth = Math.max(0, tableDepth - 1);
    }
    if (name === "tr" && tableDepth === 1) {
      flushRow();
      cells = [];
    }
    const idx = stack.lastIndexOf(name);
    if (idx >= 0) stack.length = idx;
  }
  if (cells.length > 0) flushRow();
  return rows;
}

// --- 2. 扁平 div 块 ---------------------------------------------------------

export interface DivBlock {
  /** class 里的关键标记：`text` 或 `bg-item`（其余原样给出） */
  kind: string;
  classes: string[];
  /** 块内 HTML */
  html: string;
  /** 块内纯文本 */
  text: string;
}

/**
 * 把一串扁平的 `<div class=...>` 按出现顺序拆开（不处理嵌套 div —— 魔法物品的 details
 * 已实测 12318 个 div 全部配平且无嵌套，来源若变化会被审计层报出来）。
 */
export function parseDivBlocks(html: string): DivBlock[] {
  const out: DivBlock[] = [];
  const re = /<div([^>]*)>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const cls = /class\s*=\s*"([^"]*)"|class\s*=\s*([^\s>]+)/i.exec(attrs);
    const raw = (cls?.[1] ?? cls?.[2] ?? "").trim();
    const classes = raw ? raw.split(/\s+/).filter(Boolean) : [];
    const body = m[2] ?? "";
    out.push({
      kind: classes.includes("bg-item") ? "bg-item" : classes.includes("text") ? "text" : classes.join(" "),
      classes,
      html: body,
      text: htmlToText(body),
    });
  }
  return out;
}

/** 把块头里的「标签：值」拆开（`<b>增强：</b>攻击骰…`）。 */
export function splitLabeledBlock(html: string): { label: string; valueHtml: string; value: string } | null {
  const m = /^\s*<b>([^<]{1,24}?)[:：]\s*<\/b>([\s\S]*)$/i.exec(html);
  if (!m) return null;
  return {
    label: collapseSpace(decodeEntities(m[1])).trim(),
    valueHtml: m[2] ?? "",
    value: htmlToText(m[2] ?? ""),
  };
}

// --- 3. ritualinfo 的 span 行 ----------------------------------------------

export interface Fact {
  key: string;
  value: string;
}

/**
 * 拆 `''等级：''3` 这类「标签 + 值」的 `<span>` 行。
 * 也用于仪式正文里的 `''器材：''…`。
 */
export function parseSpanFacts(html: string): Fact[] {
  const facts: Fact[] = [];
  const re = /<span>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1] ?? "";
    const text = collapseSpace(decodeEntities(htmlToText(inner)));
    if (!text) continue;
    const idx = text.search(/[:：]/);
    if (idx <= 0) continue;
    const key = text.slice(0, idx).replace(/[''"]/g, "").trim();
    const value = text.slice(idx + 1).trim();
    if (key) facts.push({ key, value });
  }
  return facts;
}

// --- 4. 自引用字段替换 -----------------------------------------------------

/**
 * 把 `{{!!field-name}}` 换成本条目的字段值。
 *
 * 维基正文里大量使用自转写（`''等级：''{{!!ritual-level}}`），渲染时才展开。
 * 数据库里存展开后的形态，下游直接拿到「等级：3」而不是模板占位符；
 * 字段不存在时保留原样，方便审计发现缺失字段。
 */
export function resolveSelfFields(html: string, fields: Record<string, string>): string {
  return html.replace(/\{\{!!([^}|]+?)\}\}/g, (whole, key: string) => {
    const k = key.trim();
    const v = fields[k];
    return v === undefined || v === "" ? whole : v;
  });
}

// --- 5. 物品等级阶梯 -------------------------------------------------------

export interface ItemTier {
  level: number;
  /** 来源宏后缀（`ns` 等），语义未见于文档，原样保留供审计 */
  suffix: string;
}

/** `<<item-level-5>>` / `<<item-level-14ns>>` → 等级阶梯。 */
export function parseItemTiers(html: string): ItemTier[] {
  const out: ItemTier[] = [];
  for (const m of html.matchAll(/<<item-level-([0-9]+)([a-z]*)>>/gi)) {
    out.push({ level: Number(m[1]), suffix: m[2] ?? "" });
  }
  return out;
}

/** `5 10 15 20 25 30` → [5,10,15,20,25,30]；`等级5+` → [5]。 */
export function parseLevelList(raw: string | undefined): number[] {
  if (!raw) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const m of raw.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** `威能✦每日（次要动作）` → { usage: 每日, action: 次要动作, keywords: [] } */
export function parsePowerHeader(text: string): { usage?: string; action?: string; keywords: string[] } {
  const t = collapseSpace(decodeEntities(text));
  const usageMatch = /✦\s*(随意|遭遇|每日|充能[^（(]*|消耗|特殊|光环|灵气)/.exec(t);
  const actionMatch = /[（(]([^）)]*?)[）)]\s*$/.exec(t);
  const kwMatch = /^[^✦]*[（(]([^）)]*)[）)]\s*✦?/.exec(t);
  return {
    usage: usageMatch?.[1]?.trim(),
    action: actionMatch?.[1]?.trim(),
    keywords: splitKeywords(kwMatch?.[1]?.trim()),
  };
}

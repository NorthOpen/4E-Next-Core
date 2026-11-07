/**
 * 文本归一化工具：wikitext/HTML → 可入库的纯文本，以及中文全文检索用的分词。
 *
 * 这一层存在的理由：数据库要同时满足两件事——
 *   1. 存得下「权威原文」（source_text 原样保留，任何结构化抽取都能回溯）；
 *   2. 查得动（FTS 里放的是剥掉标记的纯文本，否则搜「火球」会命中宏名、模板参数）。
 */

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  middot: "·",
  times: "×",
  copy: "©",
};

/** 解码 XML/HTML 实体（具名 + 十进制 + 十六进制）。 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit ?? whole;
  });
}

/** 压缩空白：全角空格与连续空格归一，去掉行首尾空白。 */
export function collapseSpace(input: string): string {
  return input.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * wikitext + HTML → 纯文本。
 *
 * 只做「会污染检索」的剥离，不做渲染：
 *   · 宏调用、转写、宏参数、自引用字段 → 删除
 *   · [[目标|别名]] → 别名（无别名用目标）
 *   · HTML 标签 → 删除，<br> 与块级闭合 → 换行
 *   · 行内样式标记（''粗体''、//斜体//、@@类名 … @@）→ 删除标记保留文字
 *   · `\"\"\"` 与 `!` 标题标记 → 删除
 */
export function toPlainText(input: string): string {
  let s = input;

  // 代码块与注释先整体丢掉（不含可检索内容）
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/\/%[\s\S]*?%\//g, " ");

  // 宏与转写在剥 HTML 之前做：否则 `<[^>]+>` 会先把 `<<macro>>` 啃成 `>`
  s = s.replace(/<<[^>]*>>/g, " ");
  s = s.replace(/\{\{[^{}]*\}\}/g, " ");

  // <br> 与块级闭合先转成换行，避免文字粘在一起
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|td|th|table)>/gi, "\n");
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");

  // wiki 链接与标题
  s = s.replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\[\]]+)\]\]/g, "$1");
  s = s.replace(/^!{1,6}\s*/gm, "");
  s = s.replace(/^---+\s*$/gm, "");

  // 行内样式：`@@类名 内容@@` 只去掉类名标记，保留内容
  s = s.replace(/'''''|'''|''|"""/g, "");
  s = s.replace(/\/\//g, "");
  s = s.replace(/@@[^\s@]+/g, " ");
  s = s.replace(/@@/g, "");

  s = decodeEntities(s);
  return collapseSpace(s);
}

/** HTML 片段 → 纯文本（保留段落换行，供 details 之类的富文本字段使用）。 */
export function htmlToText(input: string): string {
  let s = input.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(div|p|tr|li|table)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // wiki 的行内强调标记（''粗体'' / //斜体// / """引用""") 在纯文本里没有意义
  s = s.replace(/'''|"""/g, "").replace(/''/g, "");
  s = s.replace(/@@[^\s@]+/g, " ").replace(/@@/g, "");
  return s
    .split("\n")
    .map((line) => collapseSpace(line))
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---------------------------------------------------------------------------
// 中文全文检索分词
// ---------------------------------------------------------------------------

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** 是否 CJK 字符（汉字、假名、谚文）。FTS 里逐字索引，用短语查询保证连续匹配。 */
export function isCjkChar(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * 建索引用的切分：CJK 逐字加空格，拉丁/数字按词保留。
 * SQLite 的 unicode61 分词器会把一串汉字当成一个词，导致「火球」搜不到「火球术」，
 * 这里预先切开，配合查询侧的短语匹配即可得到「连续子串」语义。
 */
export function splitForIndex(text: string): string {
  const out: string[] = [];
  let latin = "";
  for (const ch of text) {
    if (CJK.test(ch)) {
      if (latin) {
        out.push(latin);
        latin = "";
      }
      out.push(ch);
    } else if (/[0-9A-Za-z\u00c0-\u024f]/.test(ch)) {
      latin += ch;
    } else {
      if (latin) {
        out.push(latin);
        latin = "";
      }
    }
  }
  if (latin) out.push(latin);
  return out.join(" ");
}

/**
 * 查询串 → FTS5 表达式。
 *
 * 规则：CJK 连续片段包成一个短语（"火 球 术"，等价于连续子串匹配）；
 * 拉丁词用带前缀的 token（`fire*`）；多个片段之间按 AND 组合。
 * 特殊字符（`"`、`*`、`(`、`:`…）全部剥离，避免把用户输入当 FTS 语法执行。
 */
export function buildFtsQuery(raw: string): string {
  const cleaned = raw.replace(/["*(){}[\]:^~\\-]/g, " ").trim();
  if (!cleaned) return "";
  const parts: string[] = [];
  let cjkRun = "";
  let latinRun = "";
  const flushCjk = (): void => {
    if (!cjkRun) return;
    const chars = Array.from(cjkRun);
    parts.push(`"${chars.join(" ")}"`);
    cjkRun = "";
  };
  const flushLatin = (): void => {
    if (!latinRun) return;
    parts.push(`${latinRun}*`);
    latinRun = "";
  };
  for (const ch of cleaned) {
    if (CJK.test(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (/[0-9A-Za-z\u00c0-\u024f]/.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushCjk();
      flushLatin();
    }
  }
  flushCjk();
  flushLatin();
  return parts.join(" ");
}

/** 从「中文名 English Name」拆出中英两段（旧管线的 parseName，保留同一行为）。 */
export function parseNameFromTitle(title: string): { name: string; nameEn?: string } {
  const m = /[A-Za-z]/.exec(title);
  if (!m || m.index === 0) return { name: title.trim() };
  const zh = title.slice(0, m.index).trim();
  const en = title.slice(m.index).trim();
  return { name: zh || title.trim(), nameEn: en || undefined };
}

/** 把逗号/顿号/斜杠分隔的关键词串切成数组（去重、保序）。 */
export function splitKeywords(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；/|]/)) {
    const k = part.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

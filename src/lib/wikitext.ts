export interface LinkRef {
  target: string;
  alias?: string;
}

// {{...}} 转写（嵌入其它 tiddler）。跳过 {{!!field}} 这类自引用字段。
export function extractTransclusions(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{([^{}]+?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body || body.startsWith("!!")) continue;
    const title = body.split("||")[0].split("!!")[0].trim();
    if (title) out.push(title);
  }
  return out;
}

// [[Target]] 或 [[Target|Alias]]
export function extractLinks(text: string): LinkRef[] {
  const out: LinkRef[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    const pipe = body.indexOf("|");
    if (pipe >= 0) {
      out.push({ target: body.slice(0, pipe).trim(), alias: body.slice(pipe + 1).trim() });
    } else {
      out.push({ target: body.trim() });
    }
  }
  return out;
}

// <<macro ...>> 宏调用，返回宏名
export function extractMacros(text: string): string[] {
  const out: string[] = [];
  const re = /<<([A-Za-z0-9-]+)[^>]*>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// 标题：行首 ! 到 !!!!!! 后跟空格
export function extractHeadings(text: string): string[] {
  const out: string[] = [];
  const re = /^(!{1,6})\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[2].trim());
  }
  return out;
}

export interface HeadingRef {
  depth: number;
  text: string;
}

/** 带层级的标题（数据库要存 depth，前端渲染目录也用它）。 */
export function extractHeadingsWithDepth(text: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  const re = /^(!{1,6})\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ depth: m[1].length, text: m[2].trim() });
  }
  return out;
}

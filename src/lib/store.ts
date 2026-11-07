import type { RawTiddler } from "../schema/raw.ts";
import { DEFAULT_TYPE } from "../schema/raw.ts";
import { parseTags } from "./tags.ts";

const OPEN = '<script class="tiddlywiki-tiddler-store" type="application/json">';
const CLOSE = "</script>";

type StoreRecord = Record<string, unknown>;

const RESERVED = new Set(["title", "tags", "text", "type"]);

/**
 * 从单文件 TW5 HTML 中提取所有 JSON store 里的 tiddler。
 * TW5 将 tiddler 以 JSON 数组形式存放在 <script class="tiddlywiki-tiddler-store" type="application/json"> 内。
 */
export function extractStoreTiddlers(html: string): RawTiddler[] {
  const out: RawTiddler[] = [];
  let pos = 0;
  for (;;) {
    const start = html.indexOf(OPEN, pos);
    if (start < 0) break;
    const contentStart = start + OPEN.length;
    const end = html.indexOf(CLOSE, contentStart);
    if (end < 0) break;
    const json = html.slice(contentStart, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error("JSON store 解析失败: " + String(e));
    }
    if (!Array.isArray(parsed)) {
      throw new Error("JSON store 内容不是数组");
    }
    for (const rec of parsed as StoreRecord[]) {
      out.push(toRawTiddler(rec));
    }
    pos = end + CLOSE.length;
  }
  return out;
}

function toRawTiddler(rec: StoreRecord): RawTiddler {
  const title = typeof rec.title === "string" ? rec.title : "";
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (RESERVED.has(k)) continue;
    fields[k] = v == null ? "" : String(v);
  }
  return {
    title,
    tags: parseTags(rec.tags),
    type: typeof rec.type === "string" && rec.type ? rec.type : DEFAULT_TYPE,
    text: typeof rec.text === "string" ? rec.text : "",
    fields,
    isSystem: title.startsWith("$:/"),
    isShadow: false,
  };
}

import { readFileSync } from "node:fs";
import { RAW_FILE } from "../lib/paths.ts";
import { writeJsonl } from "../lib/io.ts";
import { extractStoreTiddlers } from "../lib/store.ts";

/**
 * 第 1 阶段：无损抽取。
 *
 * TW5 单文件把全部 tiddler 以 JSON 数组塞在一个 `<script class="tiddlywiki-tiddler-store">` 里，
 * 这里原样取出、只补 `isSystem` 标记与 tags 数组，**不做任何内容改写**——
 * 后面所有阶段出问题时，都能回到这一层逐字节比对。
 */

export interface ExtractSummary {
  source: string;
  total: number;
  system: number;
  content: number;
  rawFile: string;
}

export function runExtract(source: string): ExtractSummary {
  const html = readFileSync(source, "utf8");
  const all = extractStoreTiddlers(html);
  writeJsonl(RAW_FILE, all);
  return {
    source,
    total: all.length,
    system: all.filter((t) => t.isSystem).length,
    content: all.filter((t) => !t.isSystem).length,
    rawFile: RAW_FILE,
  };
}

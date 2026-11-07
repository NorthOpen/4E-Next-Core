import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../lib/paths.ts";

/**
 * 源文件定位。
 *
 * 三条来源的约定统一为「按文件名特征在 data/ 与仓库根目录里找最新的一份」，
 * 这样来源更新时直接放新文件即可，不需要改代码：
 *   · 4e Wiki         文件名含 wiki / 维基，扩展名 .htm/.html
 *   · 万律            文件名含 rule / 万律，且不含 wiki / 维基（避免误取主维基）
 *   · 怪物手册        文件名含 怪物，扩展名 .xlsx
 */

interface Candidate {
  path: string;
  mtime: number;
}

function scan(match: RegExp, exts: string[], exclude?: RegExp): Candidate[] {
  const dirs = [DATA_DIR, process.cwd()];
  const hits: Candidate[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const lower = f.toLowerCase();
      if (!exts.some((x) => lower.endsWith(x))) continue;
      if (!match.test(f)) continue;
      if (exclude && exclude.test(f)) continue;
      const p = join(dir, f);
      try {
        hits.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch {
        /* 读不到修改时间就跳过 */
      }
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime);
}

/** 主维基：文件名带 wiki / 维基；一份都没有时退回目录里最新的 HTML。 */
export function findWikiSource(): string | undefined {
  const named = scan(/wiki|维基/i, [".htm", ".html"]);
  if (named.length > 0) return named[0].path;
  const fallback = scan(/./, [".htm", ".html"], /rule|万律|compendium/i);
  return fallback[0]?.path;
}

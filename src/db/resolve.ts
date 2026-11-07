import type { AliasIndex, LoadedEntry } from "./model.ts";

/**
 * wiki 引用目标 → `entry.id` 的解析。
 *
 * 维基里同一个东西有三种写法：
 *   `[[矮人恢复力 Dwarven Resilience]]`（全称）
 *   `[[矮人恢复力]]`（只有中文名）
 *   `[[阿克霍西亚尖牙学徒]]`（是真实标题 `阿克霍西亚尖牙学徒 <流派初成> Arkhosian …` 的前缀）
 *
 * 解析顺序：
 *   1. 精确命中（标题 / 中文名 / 英文名）；
 *   2. 唯一前缀命中——目标后面必须紧跟分隔符（空格、括号、尖括号）或到结尾，
 *      且**只有一个**词条符合。有歧义就放弃，绝不随便挑一个：
 *      `法师` 会命中「法师（剑咏士）/（秘法师）/（巫师）/（学派法师）/（元素法师）」五个页面，
 *      因此保持未解析，而不是给一个错的归属。
 */

const SEPARATORS = new Set([" ", "　", "（", "(", "<", "《", "[", "·"]);

export function buildAliasIndex(entries: LoadedEntry[]): AliasIndex {
  const exact = new Map<string, number>();
  const collisions: string[] = [];
  const add = (key: string, id: number): void => {
    const k = key.trim();
    if (!k) return;
    const prev = exact.get(k);
    if (prev === undefined) exact.set(k, id);
    else if (prev !== id) collisions.push(k);
  };
  for (const e of entries) {
    if (e.id === undefined) continue;
    add(e.title, e.id);
    add(e.name, e.id);
    if (e.nameEn) {
      add(e.nameEn, e.id);
      add(`${e.name} ${e.nameEn}`, e.id);
    }
  }
  return { exact, collisions };
}

interface KeyRow {
  key: string;
  id: number;
}

/**
 * 按 key 排序的前缀索引。用二分查找定位「第一个 >= target 的位置」，
 * 再往后扫到不匹配为止 —— 因为要判断「唯一」，必须知道有几个候选，
 * 但连续候选数量通常是个位数，代价可以忽略。
 */
export class Resolver {
  private readonly index: AliasIndex;
  private readonly sorted: KeyRow[];
  private readonly memo = new Map<string, number | undefined>();

  constructor(entries: LoadedEntry[], index: AliasIndex) {
    this.index = index;
    const rows: KeyRow[] = [];
    for (const e of entries) {
      if (e.id === undefined) continue;
      rows.push({ key: e.title, id: e.id });
      rows.push({ key: e.name, id: e.id });
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    this.sorted = rows;
  }

  resolve(target: string): number | undefined {
    const t = target.trim();
    if (!t) return undefined;
    if (this.memo.has(t)) return this.memo.get(t);

    let hit = this.index.exact.get(t);
    if (hit === undefined) hit = this.prefixUnique(t);
    this.memo.set(t, hit);
    return hit;
  }

  /** 唯一前缀匹配：候选必须只有 1 个，否则视为无法解析。 */
  private prefixUnique(target: string): number | undefined {
    const start = this.lowerBound(target);
    let found: number | undefined;
    for (let i = start; i < this.sorted.length; i++) {
      const key = this.sorted[i].key;
      if (!key.startsWith(target)) break;
      const next = key.charAt(target.length);
      if (next !== "" && !SEPARATORS.has(next)) continue; // 只是前缀相同，不是「同一个名字加后缀」
      const id = this.sorted[i].id;
      if (found === undefined) found = id;
      else if (found !== id) return undefined; // 有歧义
    }
    return found;
  }

  private lowerBound(target: string): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid].key < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

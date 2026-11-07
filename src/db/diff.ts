/**
 * 增量同步的核心：把一个「上一版快照」和「本版条目表」对比，算出增删改，
 * 并**复用上一版的 entry.id**。
 *
 * 为什么 id 要复用：全量重建时 id 按排序重新分配，来源里插进去一条新威能，
 * 后面所有 id 都会顺移。下游只要缓存过 id（比如收藏、书签、外部引用），就全废了。
 * 复用之后，`uid` 和 `id` 在增量更新中都是稳定的；只有首次导入才整体分配一次。
 *
 * 纯函数，不碰数据库，便于单测。
 */

export interface PrevEntry {
  id: number;
  contentHash: string;
}

export interface PrevState {
  /** uid → 上一版的 id 与内容哈希 */
  entries: Map<string, PrevEntry>;
  /** 上一版用过的最大 id（新条目从这里往后接） */
  maxId: number;
  /** 上一版是否真的存在（首次导入时为 false） */
  existed: boolean;
}

export const EMPTY_PREV: PrevState = { entries: new Map(), maxId: 0, existed: false };

export interface SyncChanges {
  initial: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

/**
 * 分配 id：上一版存在的 uid 原样沿用，新 uid 从 `maxId + 1` 顺序递增。
 * 返回的 map 一定满足「同一 id 不对应两个 uid」（因为新号段接在老号段之后）。
 */
export function assignIds(
  entries: Array<{ uid: string }>,
  prev: PrevState,
): { ids: number[]; nextId: number } {
  const ids: number[] = [];
  let next = prev.maxId;
  const used = new Set<number>();
  for (const e of entries) {
    const p = prev.entries.get(e.uid);
    if (p && !used.has(p.id)) {
      ids.push(p.id);
      used.add(p.id);
      continue;
    }
    next += 1;
    // 防御：上一版残留的 id 万一与分配器撞车，跳过（真实场景不会发生，但便宜）
    while (used.has(next) || hasId(prev, next)) next += 1;
    ids.push(next);
    used.add(next);
  }
  return { ids, nextId: next };
}

function hasId(prev: PrevState, id: number): boolean {
  for (const v of prev.entries.values()) if (v.id === id) return true;
  return false;
}

/** 对比上一版与当前条目表，产出变更清单。 */
export function diffEntries(
  current: Array<{ uid: string; contentHash: string }>,
  prev: PrevState,
): SyncChanges {
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  for (const e of current) {
    seen.add(e.uid);
    const p = prev.entries.get(e.uid);
    if (!p) added.push(e.uid);
    else if (p.contentHash !== e.contentHash) changed.push(e.uid);
    else unchanged += 1;
  }
  const removed: string[] = [];
  for (const uid of prev.entries.keys()) if (!seen.has(uid)) removed.push(uid);
  return { initial: !prev.existed, added, removed, changed, unchanged };
}

/** 变更清单落盘时的摘要（首次导入不写全量清单，只写统计 —— 几万条 uid 没有阅读价值）。 */
export interface ChangeSummary {
  initial: boolean;
  counts: { added: number; changed: number; removed: number; unchanged: number };
  added?: string[];
  changed?: string[];
  removed?: string[];
}

export function summarizeChanges(c: SyncChanges): ChangeSummary {
  const counts = {
    added: c.added.length,
    changed: c.changed.length,
    removed: c.removed.length,
    unchanged: c.unchanged,
  };
  if (c.initial) return { initial: true, counts };
  const out: ReturnType<typeof summarizeChanges> = { initial: false, counts };
  // 空清单不落盘：没有新增就不写 `"added": []`，读起来更清楚
  if (c.added.length) out.added = c.added;
  if (c.changed.length) out.changed = c.changed;
  if (c.removed.length) out.removed = c.removed;
  return out;
}

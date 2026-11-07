import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeJsonl(path: string, items: unknown[]): void {
  ensureDir(dirname(path));
  const body = items.map((it) => JSON.stringify(it)).join("\n") + "\n";
  writeFileSync(path, body, "utf8");
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** 前端按需加载的数据用紧凑 JSON（无缩进），减少传输体积 */
export function writeJsonCompact(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data), "utf8");
}

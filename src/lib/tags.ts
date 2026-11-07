// TW5 的 tags 以空格分隔；本维基未出现含空格的 [[...]] 标签，按空格切分即可。
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const s = raw.trim();
  if (!s) return [];
  return s.split(" ").filter(Boolean);
}

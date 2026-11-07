export interface ParsedName {
  name: string;
  nameEn?: string;
}

// 标题普遍形如「中文名 English Name」：以首个 ASCII 字母为分界。
export function parseName(title: string): ParsedName {
  const m = /[A-Za-z]/.exec(title);
  if (!m || m.index === 0) {
    return { name: title };
  }
  const zh = title.slice(0, m.index).trim();
  const en = title.slice(m.index).trim();
  return { name: zh || title, nameEn: en || undefined };
}

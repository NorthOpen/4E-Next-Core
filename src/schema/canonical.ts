import { z } from "zod";

/**
 * 规范层 (canonical) 溯源信息：来源页面 + 内容哈希 + 最后修订。
 * contentHash 为正文（sourceText）的 sha256，用于增量同步 diff 检测。
 */
export const ProvenanceSchema = z.object({
  page: z.string(),
  contentHash: z.string(),
  modified: z.string().optional(),
  modifier: z.string().optional(),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * 规范层条目 schema：稳定 ID + schemaVersion + category + 溯源 + 全量表单。
 * 现有扁平计算字段（usage/grantedBy/…）通过 .passthrough() 保留，作为「文本保留 + 计算字段渐进提取」的兜底。
 * schemaVersion 变更时需在 loaders/前端做对应迁移（与 migrateCharacter 思路一致）。
 */
export const CanonicalEntrySchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(1),
    category: z.string().min(1),
    name: z.string().min(1),
    nameEn: z.string().optional(),
    tags: z.array(z.string()),
    source: z.string().optional(),
    magazine: z.string().optional(),
    sourceText: z.string(),
    fields: z.record(z.string(), z.string()),
    wiki: z.object({
      transclusions: z.array(z.string()),
      links: z.array(z.object({ target: z.string(), alias: z.string().optional() })),
      macros: z.array(z.string()),
      headings: z.array(z.string()),
    }),
    provenance: ProvenanceSchema,
  })
  .passthrough();

export type CanonicalEntry = z.infer<typeof CanonicalEntrySchema>;
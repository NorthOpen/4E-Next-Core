import { z } from "zod";

export const DEFAULT_TYPE = "text/vnd.tiddlywiki";

/**
 * 无损层 tiddler：从 TW5 JSON store 提取，保留全部原始字段与正文以便溯源。
 */
export const RawTiddlerSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  type: z.string(),
  text: z.string(),
  fields: z.record(z.string(), z.string()),
  isSystem: z.boolean(),
  isShadow: z.boolean(),
});

export type RawTiddler = z.infer<typeof RawTiddlerSchema>;

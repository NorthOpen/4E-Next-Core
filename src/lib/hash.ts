import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** 对文本计算 sha256，返回十六进制字符串（用于规范层内容哈希、增量 diff 检测）。 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 对二进制文件计算 sha256（用于大体积来源文件指纹，如 44MB 的怪物手册 xlsx）。 */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
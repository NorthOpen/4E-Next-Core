import { join } from "node:path";

/**
 * 全项目唯一的路径定义。所有 ETL 阶段只用这里的常量拼路径，
 * 换目录结构时只改这一个文件（旧项目里路径散落在各处，这是重构的重点之一）。
 */

/** 输入：源文件都放这里（4e Wiki 单文件、万律书、怪物手册 xlsx） */
export const DATA_DIR = join(process.cwd(), "data");

/** 输出根目录 */
export const OUT_DIR = join(process.cwd(), "out");

/** 无损层：TW5 tiddler 原文逐条落盘 */
export const RAW_DIR = join(OUT_DIR, "raw");
export const RAW_FILE = join(RAW_DIR, "tiddlers-raw.jsonl");

/** 规范层：一条词条一个对象 + 溯源哈希（增量同步依据） */
export const CANONICAL_DIR = join(OUT_DIR, "canonical");

/**
 * 派生层：按类别分文件的紧凑 JSON。
 * 归类结果 `_classification.json` 也放在这里（它和类别数组是同一层的产物）。
 */
export const CATEGORIES_DIR = join(OUT_DIR, "categories");

/** 万律书（4e Rules Compendium）产物 */
export const RULES_DIR = join(OUT_DIR, "rules");

/** 怪物手册（怪物手册 1~3 合订本 xlsx）管线产物根目录 */
export const MONSTERS_DIR = join(OUT_DIR, "monsters");
export const MONSTERS_RAW_DIR = join(MONSTERS_DIR, "raw");
export const MONSTERS_BLOCKS_DIR = join(MONSTERS_DIR, "blocks");
export const MONSTERS_CANONICAL_DIR = join(MONSTERS_DIR, "canonical");
/** 分面统计与覆盖率审计（不入库，只用于核对） */
export const MONSTERS_AUDIT_DIR = join(MONSTERS_DIR, "audit");

/** 数据库：最终交付物，直接放在仓库根目录，下游 `sqlite3 4e-next-core.db` 就能开 */
export const DB_FILE = join(process.cwd(), "4e-next-core.db");
/** 构建期的副产物（临时库、变更清单），放在 out/ 里，不参与分发 */
export const DB_DIR = join(OUT_DIR, "db");

/** 浏览器用 JSON 包（与数据库同一份数据序列化，schema 一一对应） */
export const JSON_DIR = join(OUT_DIR, "json");

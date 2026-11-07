import { z } from "zod";

/**
 * 怪物手册（DnD4E 怪物手册 1~3 合订本）数据管线的 zod 契约。
 *
 * 分层与玩家资源管线保持一致：
 *   · 无损层（raw）：xlsx 逐行原文，见 etl/monsters/extract.ts；
 *   · 分块层（blocks）：线性行流按「章节 → 怪物」切块，见 etl/monsters/segment.ts；
 *   · 规范层（canonical）：每条怪物一个对象 + provenance.contentHash（增量同步依据）。
 *
 * 设计原则同样沿用「文本保留 + 计算字段渐进提取」：sourceText 是权威原文，
 * 结构化字段（等级/防御/威能…）尽力而为地抽取，抽不到不影响条目成立，
 * 覆盖率由 audit 层报告，后续可以稳步补规则而不动上游。
 *
 * ⚠️ 与 web 端的 `creature`（私设生物）**不是同一件事**，不要混用：
 *   · `creature`（web/src/data/labels.ts，19 类私设之一，标签「生物」）对应
 *     web/src/lib/homebrewSchema.ts 的 CreatureBlock —— 官方维基体例的
 *     `<div class=creature>` HTML 数据块，供私设编辑器读写，现 205 条；
 *   · `monster`（本文件）是**怪物手册 xlsx 来源**的规范条目，927 条，
 *     字段形状（等级/职能/四防/威能 parts/插图锚点）与 CreatureBlock 完全不同。
 *
 * 因此：**不要把 `monster` 登记进 web/src/data/labels.ts 的 CATEGORY_ORDER / CATEGORY_LABELS**。
 * 那张表驱动私设页的分类管理与统计，塞进一个非私设类别会让私设页多出一个永远为空的分类。
 * 两个形状若将来需要互通（让怪物手册的怪物也能当私设编辑），走显式转换，不要合并类别键。
 * 详见 怪物数据管线.md 第 6 节。
 */

/** 来源指纹：用于判断「来源是否更新过」 */
export const MonsterSourceSchema = z.object({
  /** 仓库相对路径（不写本机绝对路径） */
  file: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  modified: z.string().optional(),
  sheets: z.array(z.object({ name: z.string(), part: z.string() })),
});
export type MonsterSource = z.infer<typeof MonsterSourceSchema>;

/** 规范层溯源：来源工作表 + 行区间 + 正文哈希 */
export const MonsterProvenanceSchema = z.object({
  sheet: z.string(),
  rowStart: z.number(),
  rowEnd: z.number(),
  contentHash: z.string(),
});
export type MonsterProvenance = z.infer<typeof MonsterProvenanceSchema>;

/** 威能/特性正文里的一小节（攻击/命中/效果/触发/前提…） */
export const MonsterPowerPartSchema = z.object({
  label: z.string(),
  text: z.string(),
});
export type MonsterPowerPart = z.infer<typeof MonsterPowerPartSchema>;

/**
 * 一条威能或特性。
 * 频率与动作类别在两种排版里位置不同：早期排版写段头（标准动作 / 特性），
 * 精华版排版写进名字括注（基本近战：触手打击（标准动作；随意））。
 * 两者都归一到 action / usage 两个字段，原文保留在 text。
 */
export const MonsterPowerSchema = z.object({
  name: z.string(),
  /** 所属段落（特性 / 标准动作 / 移动动作 / 次要动作 / 自由动作 / 触发动作 / 未分组） */
  group: z.string(),
  /** 动作类别（标准动作 / 移动动作 / 次要动作 / 自由动作 / 触发动作 / 无动作） */
  action: z.string().optional(),
  /** 使用频率（随意 / 遭遇 / 每日 / 充能 5,6 / 灵气 2） */
  usage: z.string().optional(),
  /**
   * 触发条件。来源里既可能写成正文「触发：…」，也可能塞在威能名的括注里
   * （「战争呼唤（首次重伤时；遭遇）」），主持模式要提示「什么时候能发动」，所以单独留一个字段。
   */
  trigger: z.string().optional(),
  /** 括号内的关键词（光耀，武器 / 毒素 …） */
  keywords: z.array(z.string()),
  parts: z.array(MonsterPowerPartSchema),
  /** 段头 + 正文原文 */
  text: z.string(),
});
export type MonsterPower = z.infer<typeof MonsterPowerSchema>;

/** 六项能力值 */
export const MonsterAbilitySchema = z.object({
  score: z.number(),
  mod: z.string(),
});
export type MonsterAbility = z.infer<typeof MonsterAbilitySchema>;

export const MonsterSkillSchema = z.object({
  name: z.string(),
  bonus: z.string(),
});
export type MonsterSkill = z.infer<typeof MonsterSkillSchema>;

export const MonsterImageSchema = z.object({
  /** xlsx 内的媒体部件路径，如 xl/media/image12.jpeg */
  part: z.string(),
  caption: z.string(),
  /** 图片锚点所在行（1 基） */
  anchorRow: z.number(),
});
export type MonsterImage = z.infer<typeof MonsterImageSchema>;

/** 规范层条目：一条怪物 */
export const MonsterEntrySchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(1),
    category: z.literal("monster"),
    /**
     * 抽取器版本。contentHash 只覆盖原文，抽取规则变化时原文哈希不变，
     * 增量同步会误以为条目没变而沿用旧字段；靠这个版本号强制重抽。
     */
    extractorVersion: z.string(),

    name: z.string().min(1),
    nameEn: z.string().optional(),
    /** 所属章节（如 天使ANGEL） */
    section: z.string(),
    /** 所属书（MM1 / MM2 / MM3 / 附录） */
    book: z.string(),
    /** 章节是否在「目录」表里对齐上了（未对齐时 book 为按位置继承，可信度低） */
    bookMatched: z.boolean(),

    level: z.number().int().optional(),
    /** 类型：杂兵 / 精英 / 头目 / 强者 / 坐骑 / 精英头目 … */
    rank: z.string().optional(),
    /** 职能：蛮战 / 游击 / 护卫 / 控制 / 远程 / 伏击 */
    role: z.string().optional(),
    /** 界域：自然界 / 元素界 / 精界 / 星界 / 异界 / 影界 */
    origin: z.string().optional(),
    /** 生物类别：类人生物（不死生物）… */
    creatureType: z.string().optional(),
    /** 生物种群：恶魔 / 元素生物 / 人类 … */
    creatureGroup: z.string().optional(),
    xp: z.number().int().optional(),

    hp: z.number().int().optional(),
    bloodied: z.number().int().optional(),
    ac: z.number().int().optional(),
    fortitude: z.number().int().optional(),
    reflex: z.number().int().optional(),
    will: z.number().int().optional(),
    initiative: z.string().optional(),
    perception: z.string().optional(),
    /** 速度原文（如「6，飞行 8（盘旋）」） */
    speed: z.string().optional(),
    senses: z.array(z.string()),
    immunities: z.array(z.string()),
    resistances: z.array(z.string()),
    vulnerabilities: z.array(z.string()),
    savingThrow: z.string().optional(),
    actionPoints: z.number().int().optional(),

    abilities: z.record(z.string(), MonsterAbilitySchema),
    skills: z.array(MonsterSkillSchema),
    languages: z.array(z.string()),
    alignment: z.string().optional(),
    equipment: z.array(z.string()),

    /** 段头「特性」下的条目 */
    traits: z.array(MonsterPowerSchema),
    /** 行动段（标准动作/移动动作/…）下的条目 */
    powers: z.array(MonsterPowerSchema),

    image: MonsterImageSchema.optional(),
    /** 图片说明原文（如「左：熊；右：凶暴熊，图片出自 4E《怪物图鉴》」） */
    caption: z.string().optional(),
    /** 译注等附注 */
    notes: z.array(z.string()),

    /** 正文原文（分块原文，权威） */
    sourceText: z.string(),
    /** 抽取过程中的补充字段（总表对齐结果等） */
    fields: z.record(z.string(), z.string()),
    provenance: MonsterProvenanceSchema,
  })
  .passthrough();

export type MonsterEntry = z.infer<typeof MonsterEntrySchema>;

import { sha256Hex } from "../../lib/hash.ts";
import type { MonsterEntry, MonsterPower, MonsterPowerPart, MonsterAbility } from "../../schema/monster.ts";
import type { MonsterBlock } from "./segment.ts";
import type { MonsterImageAnchor, MonsterIndexRow } from "./extract.ts";

/**
 * 字段抽取层：把怪物块的原文抽成结构化字段。
 *
 * 排版有两种世代，抽取规则必须同时兼容：
 *   · 早期（怪物图鉴 1/2/3 体例）：段头行给动作类别（标准动作 / 移动动作 / 特性），
 *     威能头形如「基本近战：巨剑（光耀，武器）·随意」，正文另起一行以「攻击：」开头；
 *   · 精华版体例：没有段头，动作与频率写进威能名的括注
 *     （「基本近战：触手打击（标准动作；随意）」），正文形如「触及 5；+39vs.AC；3d8+8 伤害。」
 *
 * 抽取哲学与玩家资源管线一致：sourceText 永远是权威，这里只做「尽力而为的结构化」。
 * 抽不到的字段就不写，覆盖率由 audit 层报告——绝不为了凑字段而猜。
 */

/** 抽取器版本：调整下面的切分/抽取规则时递增，触发规范层全量重抽 */
export const MONSTER_EXTRACTOR_VERSION = 4;

// ——— 词汇表 ———

/** 段头行：只有这些词单独成行时才当段落标题，避免把威能名误判成段头 */
const SEGMENT_LABELS = new Set([
  "特性", "标准动作", "移动动作", "次要动作", "自由动作", "触发动作", "触发",
  "无动作", "直觉动作", "直觉中断", "直觉反应", "特制", "灵气", "攻击", "辅助",
  // 原文里偶尔出现的孤立动作类别行（如巨魔块里的「基本近战」孤行）
  "基本近战", "基本远程",
]);

const RANKS = ["杂兵", "精英", "头目", "强者", "坐骑", "精英头目", "杂兵头目", "独一", "下属"];
const ROLES = ["蛮战", "游击", "护卫", "控制", "远程", "伏击", "杂兵"];
const ORIGINS = ["自然界", "元素界", "精界", "星界", "异界", "影界", "暗影界", "妖精界", "虚空界", "原体", "未知"];
const SENSE_WORDS = [
  "黑暗视觉", "昏暗视觉", "低光视觉", "全域视野", "真视", "盲视", "盲感",
  "震动感知", "灵敏嗅觉", "微光视觉", "心灵感应",
];
const ABILITY_NAMES = ["力量", "体质", "敏捷", "智力", "感知", "魅力"];

/** 正文小节的起始标签（攻击/命中/效果…）；出现在行首时一定是威能正文而不是威能头 */
const BODY_PREFIX_RE =
  /^(攻击|效果|命中|失手|触发|前提|初始效果|后续效果|维持|特殊|目标|射程|持续|次要效果|首次豁免失败时|豁免失败时)\s*[：:（(]/;

/** 行内出现攻击加值（…；+39vs.AC；…）也算正文，威能头里不会出现 vs. */
const BODY_HINT_RE = /[；;]\s*[+-]?\d+\s*vs\.|^[+-]?\d+\s*vs\./;

/** 明确的威能头信号（动作+频率括注，或「·频率」后缀） */
const STRONG_HEAD_RE =
  /[·・](随意|遭遇|每日|充能|每遭遇|灵气\s*\d+)|（[^）]*(标准动作|移动动作|次要动作|自由动作|触发动作|无动作|直觉|随意|遭遇|每日|充能)[^）]*）/;

/** 数值行：以字段名开头的行不参与威能切分 */
const FIELD_LINE_RES = [
  /^(HP|AC|XP|LV)\s*[0-9]/i,
  /^(HP|AC)\s*[；;]/i,
  /^(强韧|反射|意志|行动点|豁免)\s*[+-]?\d/,
  /^(速度|先攻|侦查)\s*([：:]|[+-]?\d)/,
  /^(免疫|抗性|易伤|感官|技能|阵营|语言|装备)\s*[：:]/,
  /^(力量|体质|敏捷|智力|感知|魅力)\s*\d/,
  /^失手攻击无法伤害杂兵/,
];

/** 取列表字段值时用来截断的后续字段名 */
const LIST_STOP_WORDS = [
  "免疫", "抗性", "易伤", "豁免", "行动点", "语言", "装备", "阵营", "感官", "技能",
  "速度", "先攻", "侦查", "重伤", "HP", "AC", "强韧", "反射", "意志", "XP", "LV",
];

// ——— 小工具 ———

function splitLines(v: string): string[] {
  return v
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function isSegmentLabel(line: string): boolean {
  return SEGMENT_LABELS.has(line);
}

function isFieldLine(line: string): boolean {
  return FIELD_LINE_RES.some((re) => re.test(line));
}

/** 图注行、译注行、整行括注（如「（巨蚁）」「（从左往右：…）」）都是元信息，不属于威能正文 */
function isMetaLine(line: string): boolean {
  const t = line.trim();
  if (/图片出自/.test(t) || /译注/.test(t)) return true;
  return /^[（(][^）)]*[）)]$/.test(t);
}

/**
 * 把跨行断开的括号补成一行。
 * 译注经常跨行（「（译注：…
…仍按原文）」），不合并的话后半截会被当成一条威能。
 */
function joinOpenParens(lines: string[]): string[] {
  const out: string[] = [];
  let buf: string | null = null;
  for (const line of lines) {
    if (buf !== null) {
      buf = buf + line;
      if (countOpenParen(buf) <= countCloseParen(buf)) {
        out.push(buf.trim());
        buf = null;
      }
      continue;
    }
    if (countOpenParen(line) > countCloseParen(line)) {
      buf = line;
      continue;
    }
    out.push(line);
  }
  if (buf !== null) out.push(buf.trim());
  return out;
}

/** 原文里全角「（」配半角「)」的情况不少见，配对时两种都要算 */
function countOpenParen(s: string): number {
  let n = 0;
  for (const c of s) if (c === "（" || c === "(") n++;
  return n;
}

function countCloseParen(s: string): number {
  let n = 0;
  for (const c of s) if (c === "）" || c === ")") n++;
  return n;
}

/**
 * 有些行把「灵气名 + 灵气正文」或「灵气正文 + 数值行」挤在同一物理行里
 * （如「腐烂恶臭（毒素） 灵气 2：…虚弱。 HP34；重伤 17 …」），需要先按字段边界拆开，
 * 否则整行会被当成一条威能的名字。
 */
const INLINE_FIELD_RE = [
  "(?:HP|AC|XP)\\d",
  "(?:强韧|反射|意志|行动点)\\s*\\d",
  "速度\\s*[：:]?\\s*[+-]?\\d",
  "先攻\\s*[+-]?\\d",
  "侦查\\s*[+-]?\\d",
  "豁免\\s*[+-]\\d",
  "(?:力量|体质|敏捷|智力|感知|魅力)\\s*\\d",
  "(?:技能|阵营|语言|装备|免疫|抗性|易伤|感官)\\s*[：:]",
].join("|");

/**
 * 拆点必须「像新字段开头」：前面是句读，或者前一段空白很长（表格列间距）。
 * 只按空白拆会把正文里的「有一个 LV7 或以上的友方骑手」拆断。
 */
const INLINE_BREAK_RE = new RegExp(
  "(?<=[。；)）])\\s+(?=" + INLINE_FIELD_RE + ")" +
    "|(?<=\\s{2,})(?=" + INLINE_FIELD_RE + ")" +
    "|\\s+(?=灵气\\s*(?:\\d+|视线|特殊)\\s*[：:；;])"
);

function normalizeBodyLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const part of line.split(INLINE_BREAK_RE)) {
      const t = part.trim();
      if (t !== "") out.push(t);
    }
  }
  return out;
}

function isBodyLine(line: string): boolean {
  return BODY_PREFIX_RE.test(line) || BODY_HINT_RE.test(line);
}

/**
 * 该行是否「没有收尾」——原文按显示宽度硬换行，被截断的句子下一行是续行而不是新威能头。
 * 注意「：」要算作未收尾（冒号后面必然还有内容），否则「混沌增生：」后面那行会被误判成威能头。
 */
function endsOpen(line: string): boolean {
  return !/[。；！？)）】》」]$/.test(line.trim());
}

/**
 * 该行像不像一个威能名。
 * 真正的威能名很短、且不含句读；描述性长句（硬换行后独立成行的续写）一定含「。」或「；」。
 * 判据前先去掉括注，因为动作/频率/触发条件都写在括注里，括注内出现「；」是正常的。
 */
function headLike(line: string): boolean {
  const stripped = line.replace(/[（(][^）)]*[）)]/g, "").trim();
  if (stripped.length === 0) return true;
  if (/[。；]/.test(stripped)) return false;
  return stripped.length <= 40;
}

function grab(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  if (!m || m[1] === undefined) return undefined;
  const v = m[1].trim();
  return v === "" ? undefined : v;
}

function numOrUndef(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 取「标签：值」型字段。
 *
 * 关键点：值必须截断在下一个字段名之前。原文常把多个字段挤在一行
 * （「免疫：恐惧；抗性：10 光耀」「技能：洞察+16  感知 19（+11）魅力 14（+9）」），
 * 不截断就会把「抗性：10 光耀」当成一条免疫、把「感知 19」当成一个技能名。
 */
function fieldValue(text: string, label: string, stops: string[] = LIST_STOP_WORDS): string | undefined {
  const re = new RegExp(label + "\\s*[：:]\\s*([^\\n]*)");
  const m = re.exec(text);
  if (!m) return undefined;
  let v = m[1];
  const stopRe = new RegExp("\\s{2,}|" + stops.join("|"));
  const sm = stopRe.exec(v);
  if (sm) v = v.slice(0, sm.index);
  v = v.replace(/[，,；;、\s]+$/, "").trim();
  return v === "" ? undefined : v;
}

/** 把一段文本截断到下一个字段标签之前（速度这类无冒号字段用） */
function chopAtNextField(s: string): string {
  const re = new RegExp("\\s{2,}|" + LIST_STOP_WORDS.join("|"));
  const m = re.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  if (v.trim() === "-" || v.trim() === "—" || v.trim() === "无") return [];
  return v
    .split(/[，,；;]/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "-");
}

// ——— 名称行 ———

export interface MonsterHeaderInfo {
  name: string;
  nameEn?: string;
  level?: number;
  rank?: string;
  role?: string;
}

/** 「勇气天使老兵（Angel of Valor Veteran）    LV16  杂兵 护卫」→ 名称 / 英文 / 等级 / 类型 / 职能 */
export function parseHeaderLine(line: string, subLine: string): MonsterHeaderInfo {
  let name = line.trim();
  let nameEn: string | undefined;
  const paren = /^(.*?)[（(]([^）)]*)[）)]\s*(.*)$/.exec(line.trim());
  let tail = "";
  if (paren) {
    name = paren[1].trim();
    nameEn = paren[2].trim() || undefined;
    tail = paren[3].trim();
  } else {
    const m = /[A-Za-z]/.exec(line);
    if (m && m.index > 0) {
      name = line.slice(0, m.index).trim();
      nameEn = line.slice(m.index).trim() || undefined;
    }
  }

  // LV 与职能既可能写在名称行尾部，也可能写在体型行（精华版体例）
  const lvSource = tail + " " + subLine;
  const level = numOrUndef(grab(lvSource, /LV\s*(\d+)/i));

  let rank: string | undefined;
  let role: string | undefined;
  for (const token of tail.split(/\s+/)) {
    if (!token) continue;
    const bare = token.replace(/[（(].*$/, "").replace(/[）)]/g, "");
    if (RANKS.includes(bare)) {
      rank = rank ? rank + " " + token : token;
      continue;
    }
    if (ROLES.includes(bare) && !role) role = bare;
  }
  const rankParen = /（[^）]*头目[^）]*）/.exec(tail);
  if (rankParen && rank && !rank.includes("头目")) rank = rank + rankParen[0];
  return { name, nameEn, level, rank, role };
}

export interface MonsterSubInfo {
  size?: string;
  origin?: string;
  creatureType?: string;
  xp?: number;
}

/** 「中型 星界 类人生物（天使）  XP1000」→ 体型 / 界域 / 生物类别 / XP */
export function parseSubLine(sub: string): MonsterSubInfo {
  const xp = numOrUndef(grab(sub, /XP\s*(\d+)/i));
  let rest = sub.replace(/XP\s*\d+/gi, "").trim();
  rest = rest.replace(/\s{2,}/g, " ").trim();
  const sizeM = /^(微型|小型|中型|大型|超大型|巨型)\s*/.exec(rest);
  const size = sizeM ? sizeM[1] : undefined;
  if (sizeM) rest = rest.slice(sizeM[0].length).trim();
  if (!rest) return { size, xp };
  const parts = rest.split(/\s+/).filter(Boolean);
  let origin: string | undefined;
  if (ORIGINS.includes(parts[0])) origin = parts.shift();
  return { size, origin, creatureType: parts.join(" ").trim() || undefined, xp };
}

// ——— 数值字段 ———

interface StatFields {
  hp?: number;
  bloodied?: number;
  ac?: number;
  fortitude?: number;
  reflex?: number;
  will?: number;
  initiative?: string;
  perception?: string;
  speed?: string;
  senses: string[];
  immunities: string[];
  resistances: string[];
  vulnerabilities: string[];
  savingThrow?: string;
  actionPoints?: number;
  abilities: Record<string, MonsterAbility>;
  skills: { name: string; bonus: string }[];
  languages: string[];
  alignment?: string;
  equipment: string[];
}

export function parseStatFields(text: string): StatFields {
  const hp = numOrUndef(grab(text, /HP\s*(\d+)/i));
  const bloodied = numOrUndef(grab(text, /重伤\s*(\d+)/));
  const ac = numOrUndef(grab(text, /\bAC\s*(\d+)/i));
  const fortitude = numOrUndef(grab(text, /强韧\s*(\d+)/));
  const reflex = numOrUndef(grab(text, /反射\s*(\d+)/));
  const will = numOrUndef(grab(text, /意志\s*(\d+)/));
  const initiative = grab(text, /先攻\s*([+-]?\d+)/);
  const perception = grab(text, /侦查\s*([+-]?\d+)/);

  const rawSpeed = grab(text, /速度\s*[：:]?\s*([0-9飞行游泳攀爬掘穴瞬移][^\n]*)/);
  const speed = rawSpeed ? chopAtNextField(rawSpeed) : undefined;

  // 感官可能带范围（盲视 10 / 震动感知 10），只取词名会丢信息
  const senses: string[] = [];
  for (const w of SENSE_WORDS) {
    const m = new RegExp(w + "\\s*(\\d+)").exec(text);
    if (m) senses.push(w + " " + m[1]);
    else if (text.includes(w)) senses.push(w);
  }
  const immunities = splitList(fieldValue(text, "免疫"));
  const resistances = splitList(fieldValue(text, "抗性"));
  const vulnerabilities = splitList(fieldValue(text, "易伤"));
  const savingThrow = grab(text, /豁免\s*([+-]?\d+)/);
  const actionPoints = numOrUndef(grab(text, /行动点\s*(\d+)/));

  const abilities: Record<string, MonsterAbility> = {};
  const abilityRe = /(力量|体质|敏捷|智力|感知|魅力)\s*(\d+)\s*[（(]\s*([+-]?\d+)\s*[）)]/g;
  let am: RegExpExecArray | null;
  while ((am = abilityRe.exec(text))) {
    if (!ABILITY_NAMES.includes(am[1]) || abilities[am[1]]) continue;
    abilities[am[1]] = { score: Number(am[2]), mod: am[3] };
  }

  const skills: { name: string; bonus: string }[] = [];
  const skillText = fieldValue(text, "技能");
  if (skillText) {
    for (const item of skillText.split(/[，,]/)) {
      const m = /^(.+?)\s*([+-]\d+)\s*$/.exec(item.trim());
      if (m) skills.push({ name: m[1].trim(), bonus: m[2] });
    }
  }

  return {
    hp, bloodied, ac, fortitude, reflex, will,
    initiative, perception, speed, senses,
    immunities, resistances, vulnerabilities,
    savingThrow, actionPoints,
    abilities, skills,
    languages: splitList(fieldValue(text, "语言")),
    alignment: fieldValue(text, "阵营"),
    equipment: splitList(fieldValue(text, "装备")),
  };
}

// ——— 威能 / 特性 ———

export interface PowerParseResult {
  traits: MonsterPower[];
  powers: MonsterPower[];
}

/** 频率用词：只有这些才算「使用频率」，其余跟在 · 后面的都是关键词 */
const FREQ_RE = /^(随意|遭遇|每日|充能|每遭遇|灵气\s*\d+)/;
/** 触发条件：以「时」收尾，或带「触发 / 当…」字样 */
const TRIGGER_RE = /时$|触发|^当/;

function parsePowerHead(line: string): MonsterPower {
  let head = line.trim();
  let usage: string | undefined;

  // 「…·随意」「…·充能 5,6」是使用频率；「…·黯蚀」「…·强酸，结界」是关键词。
  // 精华版体例里 · 两种含义都用，只能靠词表区分，一律当频率会把关键词吃进 usage。
  const dot = /[·・]\s*([^·・]*)$/.exec(head);
  const keywords: string[] = [];
  let action: string | undefined;
  let trigger: string | undefined;
  if (dot) {
    const tail = dot[1].trim();
    if (FREQ_RE.test(tail)) usage = tail;
    else keywords.push(...tail.split(/[，,]/).map((s) => s.trim()).filter(Boolean));
    head = head.slice(0, dot.index).trim();
  }
  // 括注里可能塞着四种东西：动作类别、使用频率、触发条件、关键词
  for (const p of [...head.matchAll(/[（(]([^）)]*)[）)]/g)]) {
    const inner = p[1].trim();
    if (!inner) continue;
    for (const seg of inner.split(/[；;]/).map((s) => s.trim()).filter(Boolean)) {
      if (SEGMENT_LABELS.has(seg)) {
        if (!action) action = seg;
        continue;
      }
      // 「自由动作，当该巢穴蚁后 10 格内…时；随意」——动作类别后还跟着触发条件，取前缀即可
      const actionPrefix = /^(标准动作|移动动作|次要动作|自由动作|触发动作|无动作|直觉[^，,；;]*)/.exec(seg);
      if (actionPrefix) {
        if (!action) action = actionPrefix[1];
        // 「自由动作，当…时」——动作词后面还跟着触发条件，别丢
        const rest = seg.slice(actionPrefix[1].length).replace(/^[，,、\s]+/, "").trim();
        if (rest && TRIGGER_RE.test(rest) && !trigger) trigger = rest;
        continue;
      }
      if (FREQ_RE.test(seg)) {
        usage = usage ? usage + "；" + seg : seg;
        continue;
      }
      if (TRIGGER_RE.test(seg)) {
        if (!trigger) trigger = seg;
        continue;
      }
      keywords.push(...seg.split(/[，,]/).map((s) => s.trim()).filter(Boolean));
    }
  }
  head = head.replace(/[（(][^）)]*[）)]/g, "").trim();

  // 「基本近战：巨剑」→ 动作类别前缀 + 威能名
  let kind = "";
  let name = head;
  const colon = /^([^：:]{1,12})[：:]\s*(.*)$/.exec(head);
  if (colon) {
    kind = colon[1].trim();
    name = colon[2].trim();
  }

  const parts: MonsterPowerPart[] = [];
  if (kind) parts.push({ label: "类型", text: kind });
  return { name: name || head, group: "未分组", action, usage, trigger, keywords, parts, text: line.trim() };
}

/**
 * 把块内容行切成威能/特性。
 *
 * 状态机：段头行开新段；段内第一行是威能头，紧随其后的一行是它的正文；
 * 之后的行若是「攻击：/命中：/效果：…」这类正文标签、含攻击加值，或者只是上一行的硬换行续行，
 * 就并入上一条，否则视为新的威能头。
 *
 * 「续行」这条判据是必需的：原文按显示宽度硬换行，长段落的尾巴会单独成行
 * （如「…则它成为最后一个指定它的天使 / 的守护对象。」），没有它就会把「的守护对象。」
 * 当成一条威能。
 */
export function parsePowers(text: string, headerLineCount = 2): PowerParseResult {
  const raw = joinOpenParens(splitLines(text));
  // 头部两行（名称行 + 体型行）是元数据，不参与威能切分；只对正文做拆分归一
  const lines = raw.slice(0, headerLineCount).concat(normalizeBodyLines(raw.slice(headerLineCount)));
  const traits: MonsterPower[] = [];
  const powers: MonsterPower[] = [];
  // 用状态对象而不是裸变量：闭包里赋值会让 TS 的控制流分析认定变量恒为 null
  const st: { power: MonsterPower | null; group: string; expectBody: boolean; prevOpen: boolean } = {
    power: null,
    group: "未分组",
    expectBody: false,
    prevOpen: false,
  };

  const flush = (): void => {
    const p = st.power;
    if (!p) return;
    (p.group === "特性" ? traits : powers).push(p);
    st.power = null;
  };
  const makeHead = (line: string, g: string): MonsterPower => {
    const p = parsePowerHead(line);
    p.group = g;
    return p;
  };

  for (let i = headerLineCount; i < lines.length; i++) {
    const line = lines[i];
    if (isMetaLine(line)) {
      flush();
      st.expectBody = false;
      st.prevOpen = false;
      continue;
    }
    if (isSegmentLabel(line)) {
      flush();
      st.group = line;
      st.expectBody = false;
      st.prevOpen = false;
      continue;
    }
    if (isFieldLine(line)) {
      flush();
      st.expectBody = false;
      st.prevOpen = false;
      continue;
    }
    if (st.power === null) {
      st.power = makeHead(line, st.group);
      st.expectBody = true;
      st.prevOpen = endsOpen(line);
      continue;
    }
    const target = st.power;

    const strongHead = STRONG_HEAD_RE.test(line);
    const bodyish = isBodyLine(line);
    // 期待正文时：只有出现明确的威能头信号才算新威能（否则一律当正文，含续行）
    // 否则：正文标签 / 硬换行续行 / 以句号收尾的行都算正文，其余算新威能头
    const newHead = st.expectBody
      ? strongHead && !bodyish
      : !bodyish && !(st.prevOpen && !strongHead) && headLike(line);

    if (newHead) {
      flush();
      st.power = makeHead(line, st.group);
      st.expectBody = true;
      st.prevOpen = endsOpen(line);
      continue;
    }

    target.text = target.text + "\n" + line;
    target.parts.push(splitBodyPart(line));
    st.expectBody = false;
    st.prevOpen = endsOpen(line);
  }
  flush();

  // 精华版排版没有段头，动作类别写在威能名的括注里；用它补出归属段
  for (const p of powers) {
    if (p.group === "未分组" && p.action) p.group = p.action;
  }
  return { traits, powers };
}
/** 「攻击：近战 1（一个生物）+19vs.AC」→ { label: 攻击, text: 近战 1（一个生物）+19vs.AC } */
function splitBodyPart(line: string): MonsterPowerPart {
  const m = /^([^：:]{1,12})[：:]\s*(.*)$/.exec(line.trim());
  if (m) return { label: m[1].trim(), text: m[2].trim() };
  return { label: "正文", text: line.trim() };
}

// ——— 图片归属 ———

/**
 * 图注行与图片锚点通常同行或相差一两行（图浮动在文字上方），因此按「最近图注」归属：
 * 先把锚点配给 ±3 行内有图注的块，剩下的锚点再看它是否落在某个块的行区间内。
 */
const IMAGE_WINDOW = 3;

export function assignImages(
  blocks: MonsterBlock[],
  anchors: MonsterImageAnchor[]
): { byBlock: Map<number, MonsterImageAnchor>; unmatched: MonsterImageAnchor[] } {
  const byBlock = new Map<number, MonsterImageAnchor>();
  const used = new Set<number>();
  const captionRows: { idx: number; row: number }[] = [];
  blocks.forEach((b, idx) => {
    if (b.captionRow !== undefined) captionRows.push({ idx, row: b.captionRow });
  });

  anchors.forEach((a, ai) => {
    let best: { idx: number; dist: number } | null = null;
    for (const c of captionRows) {
      const d = a.row - c.row;
      if (d < -IMAGE_WINDOW || d > IMAGE_WINDOW) continue;
      const dist = Math.abs(d);
      if (!best || dist < best.dist) best = { idx: c.idx, dist };
    }
    if (best && !byBlock.has(best.idx)) {
      byBlock.set(best.idx, a);
      used.add(ai);
    }
  });

  const unmatched: MonsterImageAnchor[] = [];
  anchors.forEach((a, ai) => {
    if (used.has(ai)) return;
    const idx = blocks.findIndex((b) => a.row >= b.rowStart && a.row <= b.rowEnd);
    if (idx >= 0 && !byBlock.has(idx)) {
      byBlock.set(idx, a);
      used.add(ai);
    } else {
      unmatched.push(a);
    }
  });
  return { byBlock, unmatched };
}

// ——— 条目组装 ———

export function buildMonsterEntry(
  block: MonsterBlock,
  indexRow: MonsterIndexRow | undefined,
  image: MonsterImageAnchor | undefined
): MonsterEntry {
  const header = parseHeaderLine(block.headerLine, block.subLine);
  const sub = parseSubLine(block.subLine);
  const stats = parseStatFields(block.text);
  const powers = parsePowers(block.text, 2);

  const fields: Record<string, string> = {};
  let level = header.level;
  let rank = header.rank;
  let role = header.role;
  let origin = sub.origin;
  let creatureType = sub.creatureType;
  let creatureGroup: string | undefined;
  let nameEn = header.nameEn;

  // 与「总表」对齐：正文里缺的字段用总表补，冲突记进 fields 供审计
  if (indexRow) {
    fields["总表行"] = String(indexRow.row);
    if (indexRow.nameEn) {
      fields["总表原文"] = indexRow.nameEn;
      if (!nameEn) nameEn = indexRow.nameEn;
    }
    if (level === undefined && indexRow.level !== undefined) level = indexRow.level;
    else if (level !== undefined && indexRow.level !== undefined && level !== indexRow.level) {
      fields["总表等级"] = String(indexRow.level);
    }
    if (!rank && indexRow.rank) rank = indexRow.rank;
    if (!role && indexRow.role) role = indexRow.role;
    if (!origin && indexRow.origin) origin = indexRow.origin;
    if (!creatureType && indexRow.creatureType) creatureType = indexRow.creatureType;
    if (indexRow.creatureGroup) creatureGroup = indexRow.creatureGroup;
  }

  const caption = block.caption;
  return {
    id: "",
    schemaVersion: 1,
    category: "monster",
    extractorVersion: String(MONSTER_EXTRACTOR_VERSION),
    name: header.name,
    nameEn,
    section: block.section,
    book: block.book,
    bookMatched: block.bookMatched,
    level,
    rank,
    role,
    origin,
    creatureType,
    creatureGroup,
    xp: sub.xp,
    hp: stats.hp,
    bloodied: stats.bloodied,
    ac: stats.ac,
    fortitude: stats.fortitude,
    reflex: stats.reflex,
    will: stats.will,
    initiative: stats.initiative,
    perception: stats.perception,
    speed: stats.speed,
    senses: stats.senses,
    immunities: stats.immunities,
    resistances: stats.resistances,
    vulnerabilities: stats.vulnerabilities,
    savingThrow: stats.savingThrow,
    actionPoints: stats.actionPoints,
    abilities: stats.abilities,
    skills: stats.skills,
    languages: stats.languages,
    alignment: stats.alignment,
    equipment: stats.equipment,
    traits: powers.traits,
    powers: powers.powers,
    image: image ? { part: image.part, caption: caption ?? "", anchorRow: image.row } : undefined,
    caption,
    notes: block.notes,
    sourceText: block.text,
    fields: { ...fields, ...(sub.size ? { 体型: sub.size } : {}) },
    provenance: {
      sheet: "数据",
      rowStart: block.rowStart,
      rowEnd: block.rowEnd,
      contentHash: sha256Hex(block.text),
    },
  };
}

/** 稳定 id：默认「中文名 英文名」；撞名时退到「中文名 英文名 (LVn)」，再撞才加序号。 */
export function assignIds(entries: MonsterEntry[]): void {
  const base = new Map<string, MonsterEntry[]>();
  for (const e of entries) {
    const b = e.nameEn ? e.name + " " + e.nameEn : e.name;
    const arr = base.get(b);
    if (arr) arr.push(e);
    else base.set(b, [e]);
  }
  for (const [b, group] of base) {
    if (group.length === 1) {
      group[0].id = b;
      continue;
    }
    const withLevel = new Map<string, MonsterEntry[]>();
    for (const e of group) {
      const k = b + " (LV" + (e.level ?? "?") + ")";
      const arr = withLevel.get(k);
      if (arr) arr.push(e);
      else withLevel.set(k, [e]);
    }
    for (const [k, g2] of withLevel) {
      if (g2.length === 1) {
        g2[0].id = k;
        continue;
      }
      g2.forEach((e, i) => {
        e.id = k + "#" + (i + 1);
      });
    }
  }
}

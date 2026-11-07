/** 数据库构建期的中间模型。db/build.ts 与 db/satellites.ts 共用。 */

export interface CanonicalRecord {
  id: string;
  schemaVersion?: number;
  category: string;
  name: string;
  nameEn?: string;
  tags?: string[];
  source?: string;
  magazine?: string;
  sourceText: string;
  fields?: Record<string, string>;
  wiki?: {
    transclusions?: string[];
    links?: { target: string; alias?: string }[];
    macros?: string[];
    headings?: string[];
  };
  provenance?: { page?: string; contentHash?: string; modified?: string; modifier?: string };
  [key: string]: unknown;
}

/** 一条待入库词条：三份来源统一到这个形状，卫星表再按 category 取 raw 里的专属字段。 */
export interface LoadedEntry {
  uid: string;
  sourceKey: "wiki" | "rules" | "monsters";
  category: string;
  title: string;
  name: string;
  nameEn?: string;
  contentType?: string;
  sourceBook?: string;
  magazine?: string;
  sourceText: string;
  created?: string;
  modified?: string;
  modifier?: string;
  revision?: string;
  isDerived: 0 | 1;
  fields: Record<string, string>;
  tags: string[];
  headings: { depth: number; text: string }[];
  links: { target: string; alias?: string }[];
  transclusions: string[];
  macros: string[];
  /** 入库后回填 */
  id?: number;
  ord?: number;
  raw: CanonicalRecord;
}

/** 卫星表层要回传给关系图构建器的边。 */
export interface SatelliteResult {
  /** [fromEntryId, toEntryId]：威能 → 授予者（职业/典范/专长…） */
  grantEdges: Array<[number, number]>;
  /** [fromEntryId, toEntryId]：专长/典范/天命 → 前提条件里点名的词条 */
  prereqEdges: Array<[number, number]>;
}

/** 引用解析结果：把 wiki 的 `[[目标]]` 映射到 entry.id。 */
export interface AliasIndex {
  exact: Map<string, number>;
  collisions: string[];
}

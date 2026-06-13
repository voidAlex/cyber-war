/**
 * 战役包七文件类型定义（CampaignPayload）— ZIP 导入导出与 schema 校验的 TS 契约
 *
 * 对应 doc/tech-design-v1.0.md §3.9（战役插件 zip 导入导出）+ §3.10（数据模型）。
 * 七文件结构：manifest / map / factions / units / commanders / rules / victory。
 *
 * TS 类型与 src/campaign-schemas/*.schema.json 严格对齐（ajv 校验导入包时引用）。
 * Rust 侧 fs_unpack_campaign 防 zip-slip 解包，前端经 ajv 校验后才加载。
 *
 * @module types/campaign
 */

import type {
  FactionSide,
  CommanderTempo,
  UnitType,
  UnitStatusFlag,
  GridType,
  TerrainType,
} from './index'

// =============================================================================
// manifest.json
// =============================================================================

/**
 * 战役包清单（manifest.json）。
 * scenarioId 用作存档 scenarioId；scenarioSeed 用作确定性种子基底。
 */
export interface CampaignManifest {
  /** 场景 id（如 verdun-1916），小写字母数字与连字符 */
  scenarioId: string
  /** 显示名（人类可读） */
  displayName: string
  /** 固定种子（确定性随机基底：scenarioSeed:turn:sequence） */
  scenarioSeed: string
  /** 数据 schema 版本（数据迁移用） */
  schemaVersion: string
  /** 玩家可选阵营 id 列表（至少一个） */
  playerFactionIds: string[]
  /** 战役描述（可选） */
  description?: string
  /** 开局局内日期（如 1916-02-21） */
  startInGameDate?: string
  /** 最大回合数（可选，与 victory.maxTurns 互为冗余校验） */
  maxTurns?: number
}

// =============================================================================
// map.json
// =============================================================================

/** 战役包网格单元（与 types/map MapCell 字段集对齐，去掉 detection 等 runtime 字段） */
export interface CampaignMapCell {
  id: string
  col: number
  row: number
  terrain: TerrainType
  movementCost: number
  defenseBonus: number
  isObjective: boolean
}

/** 战役包高价值节点（堡垒/城市/隘口，胜负条件引用） */
export interface CampaignHighValueNode {
  id: string
  name: string
  cellId: string
  controlThreshold: number
}

/** 战役包地图（map.json） */
export interface CampaignMap {
  gridType: GridType
  cols: number
  rows: number
  cells: CampaignMapCell[]
  highValueNodes: CampaignHighValueNode[]
}

// =============================================================================
// factions.json
// =============================================================================

/** 战役包阵营后勤 */
export interface CampaignFactionSupply {
  supplies: number
  ammunition: number
  fuel: number
}

/** 战役包阵营（factions.json）。
 * commanderId / theaterCommanderIds 引用 commanders.json 的 id。 */
export interface CampaignFaction {
  id: string
  name: string
  color: string
  side: FactionSide
  /** 最高统帅 id（引用 commanders.json） */
  commanderId: string
  /** 战区司令 id 列表（引用 commanders.json） */
  theaterCommanderIds?: string[]
  supply: CampaignFactionSupply
  /** 对外信任度：key=对方 factionId，value=0..100 */
  trust?: Record<string, number>
  doctrineTags: string[]
  description?: string
}

// =============================================================================
// units.json
// =============================================================================

/** 战役包单位初始坐标 */
export interface CampaignUnitCoord {
  col: number
  row: number
}

/** 战役包单位（units.json，初始部署，不含 detection 等 runtime 字段） */
export interface CampaignUnit {
  id: string
  factionId: string
  type: UnitType
  coord: CampaignUnitCoord
  strength: number
  personnel: number
  maxPersonnel: number
  fuel: number
  ammo: number
  morale: number
  fatigue: number
  status?: UnitStatusFlag[]
}

// =============================================================================
// commanders.json
// =============================================================================

/** 战役包指挥官人格数值基底（commanders.json） */
export interface CampaignCommander {
  id: string
  name: string
  /** 自然语言人格描述（L0 system prompt 稳定前缀的一部分） */
  personality: string
  /** 进攻性 0..1 */
  aggression: number
  /** 服从度 0..1（低时 director 按概率判抗命） */
  obedience: number
  /** 偏好节奏 */
  preferredTempo: CommanderTempo
  /** 学说标签（如「消耗战」「机动穿插」） */
  doctrineTags: string[]
  /** 军衔/职务（如「法国前线总指挥」「德国总参谋长」） */
  rank?: string
  /** 所属阵营 id（引用 factions.json） */
  factionId?: string
}

// =============================================================================
// rules.json
// =============================================================================

/** 情报衰减规则（rules.json.intelDecay） */
export interface CampaignIntelDecay {
  halfLifeTurns: number
  decayPerHalfLife: number
}

/** 战斗规则（rules.json.combat） */
export interface CampaignCombatRules {
  /** 消耗损耗率 */
  attritionRate?: number
  /** 炮击压制强度 */
  artillerySuppression?: number
  /** 要塞防御加成 */
  fortressDefenseBonus?: number
  /** 堑壕防御加成 */
  trenchDefenseBonus?: number
}

/** 机动规则（rules.json.movement） */
export interface CampaignMovementRules {
  baseMovementPoints?: number
  riverCrossingPenalty?: number
  fatiguePerMove?: number
}

/** 补给规则（rules.json.supply） */
export interface CampaignSupplyRules {
  sustainCostPerTurn?: number
  lowSupplyThreshold?: number
  restockRate?: number
}

/** 战役包数值规则（rules.json） */
export interface CampaignRules {
  intelDecay: CampaignIntelDecay
  combat: CampaignCombatRules
  movement?: CampaignMovementRules
  supply?: CampaignSupplyRules
}

// =============================================================================
// victory.json
// =============================================================================

/** 胜负条件类型（占节点/战损阈值/回合上限） */
export type CampaignVictoryType = 'objective' | 'casualty' | 'turn_limit'

/** 单条胜负条件 */
export interface CampaignVictoryCondition {
  id: string
  factionId: string
  type: CampaignVictoryType
  description: string
  /** 占领的目标节点 id（objective 类型引用 highValueNodes） */
  nodeId?: string
  /** 战损阈值（casualty 类型，0..1 比例） */
  casualtyThreshold?: number
  /** 被战损针对的阵营 id（casualty 类型） */
  targetFactionId?: string
}

/** 战役包胜负条件（victory.json） */
export interface CampaignVictory {
  maxTurns: number
  conditions: CampaignVictoryCondition[]
}

// =============================================================================
// CampaignPayload（七文件聚合，ZIP 打包/解包的对象形态）
// =============================================================================

/**
 * 战役包七文件聚合（ZIP 打包/解包的对象形态）。
 *
 * buildCampaignZip(payload) 把七个字段序列化为 JSON 写入 ZIP；
 * loadCampaignZip(zipData) 解包后用 ajv 校验七文件 schema，返回此对象。
 * 校验失败 throw，不加载损坏/恶意包。
 */
export interface CampaignPayload {
  manifest: CampaignManifest
  map: CampaignMap
  factions: CampaignFaction[]
  units: CampaignUnit[]
  commanders: CampaignCommander[]
  rules: CampaignRules
  victory: CampaignVictory
}

/** ZIP 内七文件的固定文件名（与 doc/tech-design-v1.0.md §3.9 战役包结构对齐） */
export const CAMPAIGN_ZIP_FILES = {
  manifest: 'manifest.json',
  map: 'map.json',
  factions: 'factions.json',
  units: 'units.json',
  commanders: 'commanders.json',
  rules: 'rules.json',
  victory: 'victory.json',
} as const

/** 当前战役包数据 schema 版本 */
export const CAMPAIGN_SCHEMA_VERSION = '1.0.0'

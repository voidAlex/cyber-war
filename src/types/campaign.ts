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

// =============================================================================
// 随机事件规则（rules.json.randomEvents，第 2 批）
// =============================================================================

/**
 * 随机事件类别。
 *
 * - weather：天气（暴雨/泥泞/严寒），通常影响全图移动/补给。
 * - gas：化学武器（毒气），特定区域单位减员。
 * - reinforcement：援军到达，新单位在指定回合出现。
 * - mutiny：兵变，低士气阵营单位士气再降。
 * - surprise：突发打击（炮击/夜袭），随机区域单位减员。
 */
export type RandomEventKind =
  | 'weather'
  | 'gas'
  | 'reinforcement'
  | 'mutiny'
  | 'surprise'

/**
 * 随机事件效果模板（声明式：描述「改谁、改什么字段、改多少」）。
 *
 * rollRandomEvents 用确定性随机（DeterministicRandom）把 selector 解析为
 * 具体单位，再把 delta 应用为 DirectorOverride（field=units.<unitId>.<field>）。
 *
 * targetKind 决定单位筛选范围：
 * - 'all'：当前 world.units 全部单位。
 * - 'faction'：某阵营全部单位（factionId 指定）。
 * - 'region'：某坐标范围内的单位（coord + radius）。
 * - 'specific'：unitIds 显式指定（用于 reinforcement 等已确定目标）。
 *
 * field 限定为 Unit 的数值字段（strength/morale/fatigue/fuel/ammo）；
 * op 为 'set'（直接设值，用于 reinforcement 新单位）/ 'add'（增减，可负）。
 */
export interface RandomEventEffectTemplate {
  /** 目标筛选类别 */
  targetKind: 'all' | 'faction' | 'region' | 'specific'
  /** faction targetKind 时指定阵营 id */
  factionId?: string
  /** region targetKind 时的中心坐标 */
  coord?: { col: number; row: number }
  /** region targetKind 时的半径（曼哈顿距离） */
  radius?: number
  /** specific targetKind 时指定的单位 id 列表 */
  unitIds?: string[]
  /** 作用字段（Unit 数值字段名，如 strength/morale） */
  field: string
  /** 操作类别：set 直接设值（reinforcement 用）；add 增量（可负） */
  op: 'set' | 'add'
  /** 数值（set 时为绝对值，add 时为增量；可负） */
  value: number
  /** 是否仅作用于单一目标（按权重随机挑一个）；false=全部命中目标 */
  singleTarget?: boolean
  /** 单一目标挑选时的筛选条件（如 morale<30 时兵变），可选 */
  filterField?: string
  /** filterField 的阈值（小于此值的单位才进入候选池） */
  filterBelow?: number
  /** 效果说明（落入 DirectorOverride.reason 供战报叙事） */
  reason: string
}

/**
 * 随机事件触发条件（声明式判定，rollRandomEvents 据此决定是否触发）。
 *
 * - 'always'：满足 turnRange 且 weight 概率命中即触发。
 * - 'morale_below'：某阵营平均士气低于 moraleThreshold 时才进入候选池
 *   （仍需 weight 概率）。
 * - 'turn_in'：turnRange 显式列回合（如 [5,10,15]），不参与概率。
 */
export interface RandomEventTriggerCondition {
  /** 判定类别 */
  kind: 'always' | 'morale_below' | 'turn_in'
  /** 阵营 id（morale_below 用） */
  factionId?: string
  /** 士气阈值（morale_below 用，阵营平均士气低于此值才候选） */
  moraleThreshold?: number
  /** 显式触发回合列表（turn_in 用，如 [5,10,15]） */
  turns?: number[]
}

/**
 * 随机事件模板（rules.json.randomEvents[]）。
 *
 * rollRandomEvents 基于 weight 概率 + triggerCondition 判定触发哪些事件，
 * 触发后用确定性随机解析 effects 为具体 DirectorOverride[]。
 */
export interface RandomEventTemplate {
  /** 事件 id（唯一） */
  id: string
  /** 类别 */
  kind: RandomEventKind
  /** 触发概率权重（0..1，每回合独立判定） */
  weight: number
  /** 触发条件（默认 always） */
  triggerCondition?: RandomEventTriggerCondition
  /** 触发回合范围 [startTurn, endTurn]（inclusive） */
  turnRange?: [number, number]
  /** 事件显示名（战报/UI 用） */
  label: string
  /** 事件描述（战报叙事用） */
  description: string
  /** 效果模板（声明式，rollRandomEvents 解析为 DirectorOverride[]） */
  effects: RandomEventEffectTemplate[]
  /**
   * 援军单位定义（仅 reinforcement 用）。
   * 触发时这些单位从 rules 注入到 world.units（不伪造：来自战役包定义）。
   * key=unitId，value=CampaignUnit（不含 runtime detection/orders/status 字段）。
   */
  reinforcementUnits?: CampaignUnit[]
}

/**
 * 已触发的随机事件实例（rollRandomEvents 产出，传给 director adjudicate）。
 *
 * effects 已解析为具体 DirectorOverride[]（field=units.<unitId>.<field>），
 * 导演部在战报中描述事件 + 把 effects 作为已确定覆写应用。
 */
export interface RandomEvent {
  /** 事件 id（来自模板） */
  id: string
  /** 类别 */
  kind: RandomEventKind
  /** 触发回合 */
  turn: number
  /** 显示名 */
  label: string
  /** 描述 */
  description: string
  /** 已解析为具体单位的覆写（DirectorOverride 格式，复用现有覆写链路） */
  effects: import('@/layers/agents/protocol/schema').DirectorOverride[]
  /**
   * 本事件触发的援军单位 id 列表（仅 reinforcement；这些单位已在 world.units 中）。
   * director/replay 据此知晓新增单位（采信 log，回放从 reinforcementUnits 重建）。
   */
  reinforcementUnitIds?: string[]
  /**
   * 援军单位完整定义（仅 reinforcement；用于 event-log 持久化 + 回放重建）。
   * director 把它写入 random_event AgentAction 的 payload.data.reinforcementUnits，
   * replay 据此在回放时把援军单位注入 world.units（采信 log，不重算）。
   */
  reinforcementUnits?: CampaignUnit[]
}

/**
 * 战术决策后果（DirectorOverride 模板，第 3 批）。
 *
 * 与运行时 DirectorOverride 的差别：模板里的 field 在导演部产出时
 * 可仍保留 `units.<unitId>.<field>` 形态（已具体到某 unit），
 * 或用占位符（如 `units.<attacker>.strength`）由导演部按本回合态势解析。
 * 实际 director mock 路径会按当前 world 把占位符替换为具体单位。
 */
export interface TacticalDecisionOverrideTemplate {
  /** 被覆写字段路径：`units.<unitId>.<field>`（field 为 Unit 数值字段） */
  field: string
  /** 覆写前值（占位符或具体值；导演部按当前 world 填充） */
  before: unknown
  /** 覆写后值（占位符或具体值；导演部按当前 world 填充） */
  after: unknown
  /** 后果说明（落入战报叙事） */
  reason: string
}

/**
 * 战术决策选项模板（第 3 批）。
 *
 * 每个选项含 label/description + 后果 overrides 模板（导演部按当前态势解析）。
 * 玩家选择后，导演部/编排器把 overrides 应用到 world（复用 DirectorOverride 链路）。
 */
export interface TacticalDecisionOptionTemplate {
  /** 选项 id（决策内唯一） */
  id: string
  /** 选项标签（UI 卡片标题） */
  label: string
  /** 选项描述（UI 卡片正文，说明后果） */
  description: string
  /** 选项后果覆写模板（DirectorOverride 模板） */
  overrides: TacticalDecisionOverrideTemplate[]
}

/**
 * 战术决策触发条件（声明式判定，第 3 批）。
 *
 * - 'turn_in'：指定回合（如 [3, 10]），到达即触发（确定性，非随机）。
 * - 'morale_below'：某阵营平均士气低于阈值时触发（动态态势条件）。
 */
export interface TacticalDecisionTriggerCondition {
  /** 判定类别 */
  kind: 'turn_in' | 'morale_below'
  /** turn_in 用：触发回合列表（如 [3, 10]） */
  turns?: number[]
  /** morale_below 用：阵营 id */
  factionId?: string
  /** morale_below 用：阵营平均士气阈值 */
  moraleThreshold?: number
}

/**
 * 战术决策模板（rules.json.decisions[]，第 3 批）。
 *
 * 导演部（mock + LLM）按 triggerCondition 判定是否触发：
 * - turn_in：确定性触发（历史节点如第 3/10 回合）。
 * - morale_below：态势触发。
 *
 * 触发后产出运行时 TacticalDecision（具体选项 + 已解析 overrides）。
 */
export interface TacticalDecisionTemplate {
  /** 决策 id（唯一） */
  id: string
  /** 触发条件 */
  triggerCondition: TacticalDecisionTriggerCondition
  /** 决策标签（UI 标题） */
  label: string
  /** 决策描述（UI 正文，说明背景） */
  description: string
  /** 选项模板（2-3 个，各有后果） */
  options: TacticalDecisionOptionTemplate[]
}

/**
 * 运行时战术决策选项（导演部产出，UI 展示用）。
 *
 * 与模板的差别：overrides 已是具体 DirectorOverride（field 路径已解析到具体单位）。
 */
export interface TacticalDecisionOption {
  /** 选项 id（来自模板） */
  id: string
  /** 选项标签 */
  label: string
  /** 选项描述 */
  description: string
  /** 已解析到具体单位的后果覆写（DirectorOverride 格式，复用现有覆写链路） */
  overrides: import('@/layers/agents/protocol/schema').DirectorOverride[]
}

/**
 * 运行时战术决策实例（导演部产出，存入 context.pendingDecision）。
 *
 * 由 DirectorAdjudicateResult.pendingDecision 传递到编排器 → OFFER_DECISION 存入 ctx →
 * UI 据此渲染 DecisionPanel → 玩家选择 → RESOLVE_DECISION 应用 overrides。
 */
export interface TacticalDecision {
  /** 决策 id（来自模板） */
  id: string
  /** 触发回合 */
  turn: number
  /** 决策标签（UI 标题） */
  label: string
  /** 决策描述（UI 正文） */
  description: string
  /** 选项列表（2-3 个，各有后果） */
  options: TacticalDecisionOption[]
}

/** 战役包数值规则（rules.json） */
export interface CampaignRules {
  intelDecay: CampaignIntelDecay
  combat: CampaignCombatRules
  movement?: CampaignMovementRules
  supply?: CampaignSupplyRules
  /**
   * 随机事件模板列表（第 2 批，可选）。
   * rollRandomEvents 据此 + 确定性随机判定每回合触发哪些事件。
   */
  randomEvents?: RandomEventTemplate[]
  /**
   * 战术决策模板列表（第 3 批，可选）。
   * 导演部按 triggerCondition 判定是否触发（如第 3/10 回合的历史节点）。
   * 触发后产出 TacticalDecision → 玩家选择 → 后果 DirectorOverride 应用。
   */
  decisions?: TacticalDecisionTemplate[]
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

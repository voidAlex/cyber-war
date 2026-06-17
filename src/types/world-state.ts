/**
 * 世界状态类型定义（WorldState）— 游戏数据唯一真相源
 *
 * 重写计划「数据模型要点」：WorldState 是唯一真相源，含 saveId/scenarioSeed/
 * turnIndex/inGameDate/factions/units/map/intel/diplomacy/directorMemory/
 * pendingOrders/lockedOrders/lastResolution/contextSummaries。
 *
 * 持久化：序列化为 world-state.json，Rust fs 原子写（临时文件+rename）。
 *
 * @module types/world-state
 */

import type { Faction } from './faction'
import type { Unit } from './unit'
import type { GameMap } from './map'
import type { ActionEnvelope } from './action-envelope'
import type { AgentAction } from './agent-action'

/**
 * 世界状态接口（唯一真相源）。
 *
 * 注意：detection/diplomacy 的细粒度记录嵌在 Unit.detection 与 faction.trust 中，
 * 此处的 intel/diplomacy 字段为「全局情报/外交规则参数与摘要」（如半衰规则、信任度事件流）。
 */
export interface WorldState {
  /** 存档 id（与 manifest.saveId 一致） */
  saveId: string
  /**
   * 玩家所选阵营 id（v0.2.2+ 必需字段）。
   *
   * 视角 bug 修复（选德军开局但参谋长报法军位置）：旧版仅依赖 faction.side==='player'
   * 推断玩家阵营，但剧本角色位 side 是硬编码的（如凡尔登 france=player/germany=enemy）。
   * 选 germany 开局时若不 swap side，所有用 side 判断的代码（AI 编排/情报/外交/沙盘渲染/
   * 参谋长视角）都会错误地把 france 当作玩家。
   *
   * 修复：WorldState 显式持有 playerFactionId（开局从 manifest.playerFactionId 注入），
   * buildInitialWorldState 据此 swap faction.side 使剧本角色位与玩家选择一致；
   * getPlayerFactionId 优先读本字段，旧存档（无此字段）fallback side==='player'。
   */
  playerFactionId: string
  /** 场景 id（如 verdun-1916） */
  scenarioId: string
  /** 场景固定种子（确定性随机 base：scenarioSeed:turn:sequence） */
  scenarioSeed: string
  /** 当前回合索引（从 0 开始） */
  turnIndex: number
  /** 局内日期（战役时间线，ISO 8601 或剧本自定义格式） */
  inGameDate: string
  /** 阵营列表 */
  factions: Faction[]
  /** 单位列表 */
  units: Unit[]
  /** 地图 */
  map: GameMap
  /** 情报全局参数与摘要（半衰规则、侦察命中流） */
  intel: WorldIntelState
  /** 外交全局摘要（信任度事件流，细粒度信任在 faction.trust） */
  diplomacy: WorldDiplomacyState
  /** 导演部记忆（跨回合累积的叙事上下文） */
  directorMemory: DirectorMemory
  /** 待确认/结算的命令信封队列（planning/handshake 阶段填充） */
  pendingOrders: ActionEnvelope[]
  /** 已锁定的命令（按 factionId 索引，locked 阶段冻结） */
  lockedOrders: Record<string, ActionEnvelope[]>
  /** 上一回合结算结果摘要（briefing 阶段展示） */
  lastResolution: ResolutionSummary | null
  /** 上下文压缩摘要（每 5 回合产出，作为新的稳定 L2 前缀） */
  contextSummaries: Record<number, string>
}

/**
 * 全局情报状态（情报规则参数与跨阵营摘要）。
 */
export interface WorldIntelState {
  /** 情报衰减规则草案（halfLifeTurns 等） */
  decayRule: {
    halfLifeTurns: number
    decayPerHalfLife: number
  }
  /** 本回合侦察命中记录流（observerFactionId → unitId → 回合） */
  reconHits: Array<{
    turn: number
    observerFactionId: string
    unitId: string
  }>
}

/**
 * 全局外交状态（信任度事件流，细粒度数值在 faction.trust）。
 */
export interface WorldDiplomacyState {
  /** 外交事件流（履约/毁约/倒戈） */
  events: AgentAction[]
  /** 当前回合是否有倒戈随机事件待 director 处理 */
  pendingDefectionCheck: boolean
}

/**
 * 导演部记忆（跨回合累积，用于 L2 上下文摘要的压缩基底）。
 */
export interface DirectorMemory {
  /** 已发生的关键事件摘要（按回合索引） */
  keyEvents: Record<number, string[]>
  /** 导演部覆写过的数值变更留痕（必须留痕，对应重写计划关键防坑表） */
  overrides: Array<{
    turn: number
    field: string
    before: unknown
    after: unknown
    reason: string
  }>
}

/**
 * 单回合结算结果摘要（briefing 阶段展示）。
 */
export interface ResolutionSummary {
  /** 结算回合 */
  turn: number
  /** 战损明细（factionId → 损失人员/装备） */
  casualties: Record<string, { personnel: number; strength: number }>
  /** 高价值节点控制变更 */
  objectiveChanges: Array<{ nodeId: string; fromFactionId: string; toFactionId: string }>
  /** 战报文本（director 润色） */
  reportText: string
  /** 是否规则引擎降级结算（无 LLM 时） */
  degraded: boolean
}

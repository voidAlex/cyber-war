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

  // ===========================================================================
  // 胜负状态 + 累计统计（第 6 批：GameOverModal 胜负弹窗）
  //
  // checkVictory 纯函数需要三类输入（controlledNodes / accumulatedCasualties /
  // scores / casualtiesInflicted / objectivesHeldTurns），这些跨回合累计统计
  // 持久化在 world 上（落盘 + 回放采信）。victoryState 是胜负终局标志位，
  // orchestrator 每回合 FINISH_RESOLUTION 后调 evaluateVictory 判定并写入。
  // ===========================================================================
  /**
   * 战役胜负终局状态。
   *
   * - 'ongoing'：战役进行中（默认）。
   * - 'won'：玩家阵营获胜（winnerFactionId === playerFactionId）。
   * - 'lost'：玩家阵营失败（winnerFactionId 为敌方）。
   * - 'draw'：平局（回合上限到达且势均力敌）。
   *
   * 旧存档（无此字段）视为 'ongoing'（兼容回填）。
   */
  victoryState?: 'ongoing' | 'won' | 'lost' | 'draw'
  /** 获胜阵营 id（未决为 null/undefined；'draw' 时为 null）。 */
  winnerFactionId?: string | null
  /** 胜负判定原因（checkVictory.reason，UI GameOverModal 展示）。 */
  victoryReason?: string | null
  /**
   * 胜负判定的剧本回合上限（来自 victory.maxTurns）。evaluateVictory 注入，
   * 用于 GameOverModal 展示「坚守至第 N 回合」。
   */
  victoryMaxTurns?: number

  /**
   * 累计战损统计（承受方视角）：key=factionId，value=该阵营累计损失的 strength 总和。
   *
   * 每回合 FINISH_RESOLUTION 后由 evaluateVictory 累加 lastResolution.casualties
   * （factionId → { personnel, strength }），存 strength 累计（checkVictory casualty
   * 条件消费此）。回放采信（落 event-log 的 world-state 副本）。
   * 旧存档（无此字段）视为空（首回合起算）。
   */
  accumulatedCasualties?: Record<string, number>
  /**
   * 累计战损统计（造成方视角）：key=施加方 factionId，value=该阵营累计造成的
   * 敌方 personnel 伤亡总和。与 accumulatedCasualties 互补（cumulative
   * casualties_inflicted 条件消费此）。
   *
   * 计算方式：本回合某阵营造成的敌方 personnel 损失 = sum(除自身外其他阵营本回合
   * 承受的 personnel 损失)（粗粒度，假设本回合所有敌方损失都由我方造成）。
   * 旧存档（无此字段）视为空。
   */
  casualtiesInflicted?: Record<string, number>
  /**
   * 当前各阵营占领的高价值节点 id 列表（key=factionId）。
   *
   * 每回合按 lastResolution.objectiveChanges 折叠更新（最新控制方覆盖旧值），
   * 作为 checkVictory 的 controlledNodes 输入。回放采信。
   * 旧存档（无此字段）视为空。
   */
  controlledNodes?: Record<string, string[]>
  /**
   * 各阵营累计积分（key=factionId）。积分规则：占节点+100 / 歼敌+10 / 回合-5
   * （由 evaluateVictory 每回合累加）。score 类型胜利条件消费此。
   * 旧存档（无此字段）视为 0。
   */
  factionScores?: Record<string, number>
  /**
   * 各阵营累计占领高价值节点的回合数（key=factionId）。
   * 每回合按当前 controlledNodes[factionId].length 累加（cumulative
   * objectives_held_turns 条件消费此）。
   * 旧存档（无此字段）视为 0。
   */
  objectivesHeldTurns?: Record<string, number>
  /**
   * 当前回合的天气状态（T1-B，可选）。
   *
   * turn-resolution 在物理结算前调 rollWeather 推进/变化天气，结果写入此字段。
   * 物理引擎（physics.worker）读 weather.modifiers 影响机动/侦察/战斗。
   * 旧存档（无此字段）视为 'clear'（晴天无 modifier），兼容回填。
   */
  weather?: WeatherState
  /**
   * 日夜循环（T1-C，缺省 'day'）。
   *
   * reducer NEXT_TURN 每回合切换 day→night→day。物理引擎读此字段：
   * - night 时 recon 单位 gainedLevel -1（最低 L0），move fuelCost ×1.2，defender morale -5。
   * - chief 解析"夜袭"时 night attack firepower +0.2（surpriseBonus）。
   * 旧存档（无此字段）视为 'day'（兼容回填）。
   */
  timeOfDay?: 'day' | 'night'
}

/**
 * 天气类型枚举（T1-B）。
 *
 * - clear：晴天（无 modifier）。
 * - rain：雨（movementCostMult 1.5）。
 * - storm：暴风雨（movementCostMult 2，visibilityPenalty -1，combatMod -0.1）。
 * - fog：雾（visibilityPenalty -2，侦察范围骤降）。
 * - snow：雪（movementCostMult 2.5，visibilityPenalty -1，combatMod -0.15）。
 */
export type WeatherType = 'clear' | 'rain' | 'storm' | 'fog' | 'snow'

/**
 * 天气对结算的 modifier 集合（T1-B）。
 *
 * - movementCostMult：机动消耗倍率（clear=1；rain=1.5；storm=2；snow=2.5）。
 * - visibilityPenalty：可见度惩罚（负值，|penalty| 用于 intel level 降级，最低 L0）。
 *   clear/rain=0；storm/snow=-1；fog=-2。
 * - combatMod：火力倍率（clear=0=不变；storm=-0.1；snow=-0.15；其余 0）。
 *   与现有 FIREPOWER_RATIO 叠加（按 (1+combatMod) 缩放）。
 */
export interface WeatherModifiers {
  movementCostMult?: number
  visibilityPenalty?: number
  combatMod?: number
}

/**
 * 当前天气状态（T1-B）。
 *
 * rollWeather 产出：remainingTurns>0 时延续当前 type；=0 时按 rng 随机新 type，持续 2-4 回合。
 * modifiers 与 type 绑定（见 rollWeather 内的 WEATHER_MODIFIER_MAP）。
 */
export interface WeatherState {
  /** 天气类型 */
  type: WeatherType
  /** 剩余持续回合数（>0 延续；=0 时下回合 rollWeather 切换） */
  remainingTurns: number
  /** 当前 type 对应的 modifier（与 type 绑定，避免各处重复映射） */
  modifiers: WeatherModifiers
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

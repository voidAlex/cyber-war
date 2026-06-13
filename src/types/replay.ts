/**
 * 回放与快照相关类型定义（replay）— 验收#7 红线数据契约。
 *
 * 确定性两层分明（TDD §3.1）：
 * - 物理层：纯数值规则 + seed，回放校验重算一致；漂移即告警（不中断）。
 * - 导演层：LLM/规则引擎产物「记录即真相」，回放从 event-log 读原文不重算。
 *
 * 本模块定义 DriftWarning（物理层重算漂移告警）与 TurnSnapshot（回合快照）。
 *
 * @module types/replay
 */

import type { WorldState } from './world-state'

/**
 * 漂移告警类型（物理层重算不一致的分类）。
 */
export type DriftKind =
  | 'seed' // 种子/确定性随机漂移（重算的随机扰动与记录值不一致）
  | 'rule' // 规则漂移（重算的确定性数值与记录值不一致）
  | 'missing' // 缺失字段（log 事件缺少重算所需数据）
  | 'recompute-error' // 重算过程抛错（环境/数据异常）

/**
 * 漂移告警（物理层回放校验不一致时产出，不中断回放）。
 *
 * 每条告警记录：哪条事件、何种漂移、期望值（重算）、记录值（log）、原因。
 * 供 CI 确定性门（验收#7）与 diagnostics 追溯。
 */
export interface DriftWarning {
  /** 触发漂移的事件 id（对应 event-log 条目） */
  eventId: string
  /** 漂移分类 */
  kind: DriftKind
  /** 关联回合 */
  turn: number
  /** 关联 sequence */
  sequence: number
  /** 触发漂移的具体字段（如 'defenderLoss' / 'attackerLoss'） */
  field: string
  /** 回放重算出的期望值 */
  expected: unknown
  /** event-log 中记录的值 */
  recorded: unknown
  /** 人类可读原因 */
  reason: string
}

/**
 * 回放产物（restoreFromEventLog 输出）。
 */
export interface RestoreResult {
  /** 从 baseWorld 回放 events 得到的、与当时一致的世界状态 */
  world: WorldState
  /** 物理层重算漂移告警列表（director/rule-engine 类不产生告警） */
  driftWarnings: DriftWarning[]
}

/**
 * 回合快照（用于崩溃恢复与回放加速）。
 *
 * 存储某回合某阶段完成后的 WorldState 深拷贝，
 * 回放时从最近快照起 replay 其后的事件。
 */
export interface TurnSnapshot {
  /** 快照所属存档 id */
  saveId: string
  /** 快照时的回合索引 */
  turnIndex: number
  /** 快照时的阶段 */
  phase: string
  /** 场景固定种子（便于回放对齐 seed） */
  scenarioSeed: string
  /** 快照时间戳（元信息，不参与确定性链路；manifest 类同） */
  createdAt: string
  /** 世界状态深拷贝 */
  world: WorldState
}

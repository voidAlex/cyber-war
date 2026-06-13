/**
 * 领域层 barrel — 全纯函数（铁律边界）。
 *
 * combat / intelligence / diplomacy / physics-rules / victory /
 * deterministic-random 均为纯函数，vitest import 时不得拉起任何
 * Tauri/fetch/crypto，不调 Date.now()/Math.random()。
 *
 * 注：M2-A 实现期间更新此 barrel 以匹配实际导出（旧桩符号已替换为真实函数）。
 * M2-D 统一收口时可进一步调整。
 *
 * @module layers/domain
 */

// 确定性随机（基石）
export { DeterministicRandom, buildSeed } from './deterministic-random'

// 物理规则（数值公式）
export {
  resolveMovement,
  computeBaselineConsumption,
  applyResupply,
  resolveDamage,
  computeEffectiveFirepower,
  computeEffectiveDefense,
  computeMoraleLoss,
  isAnnihilated,
  isLowSupply,
  getCellAt,
} from './physics-rules'
export type {
  MovementInput,
  MovementResult,
  DamageInput,
  DamageResult,
} from './physics-rules'

// 战斗结算
export {
  resolveEngagement,
  resolveCapture,
  extractPayloadField,
  extractCoord,
  makeEventId,
} from './combat'
export type {
  ResolutionEvent,
  ResolutionResult,
  CombatStateChanges,
  ResolutionEventKind,
  ResolveEngagementParams,
  EngagementOutcome,
  CaptureOutcome,
} from './combat'

// 胜负判定
export { checkVictory } from './victory'
export type { VictoryResult, VictoryCondition, VictoryCheckInput } from './victory'

// 情报衰减
export {
  decayIntel,
  applyIntelDecay,
  decayObservation,
  refreshOnRecon,
  isStale,
  staleGhostTurns,
} from './intelligence'

// 外交信任度
export {
  applyTrustChange,
  applyHonor,
  applyBreak,
  clampTrust,
  computeRejectRate,
  computeDefectionProbability,
  isAtDefectionRisk,
  inferStance,
  buildDiplomacyEvent,
} from './diplomacy'

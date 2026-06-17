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
  applyResolutionToIntel,
  applyResolutionStateChanges,
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
export { checkVictory, evaluateVictory, accumulateTurnStats } from './victory'
export type {
  VictoryResult,
  VictoryCondition,
  VictoryCheckInput,
  VictoryState,
  EvaluateVictoryOptions,
} from './victory'

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
  computeTrustTrend,
  trustRecordFromValue,
  RECENT_TREND_WINDOW,
} from './diplomacy'
export type { TrustTrend } from './diplomacy'

// 外交请求流程（M4-B：玩家→盟友统帅响应→信任度变化）
export {
  resolveDiplomaticResponse,
  rollDiplomaticResponse,
  describeRequestKind,
  describeResponseType,
  responseColor,
  inferRequestKind,
  HONOR_DELTA,
  BREAK_DELTA,
  applyDiplomacyResultToFaction,
} from './diplomacy-request'
export type {
  DiplomaticRequestKind,
  DiplomaticResponseType,
  DiplomaticRequest,
  DiplomaticResponse,
  DiplomaticRequestResult,
} from './diplomacy-request'

// T3-A：NPC 主动外交（NPC→玩家请求队列，evaluateNpcDiplomacy 纯函数）
export {
  evaluateNpcDiplomacy,
  computeFactionStrength,
  computeFactionInitialStrength,
  isFactionUnderAttack,
  NPC_CEASEFIRE_TRUST_THRESHOLD,
  NPC_REINFORCEMENT_TRUST_THRESHOLD,
  NPC_CEASEFIRE_STRENGTH_RATIO,
  NPC_THREAT_STRENGTH_RATIO,
  NPC_DIPLOMACY_BASE_PROBABILITY,
} from './diplomacy-npc'

// 补给线/后勤（第 4 批：网络化补给判定）
export {
  computeSupplyConnectivity,
  applySupplyState,
  findSupplyCutOpportunities,
  resolveSupplyMultiplier,
  SEVERED_SUPPLY_MULTIPLIER,
  SEVERED_MORALE_PENALTY,
} from './supply'
export type { SupplyConnectivity } from './supply'

// T2 第 2 批：电子战（EW 被动效果纯函数）
export { applyEWEffects } from './electronic-warfare'
export type { EWEffectsResult, EWDetectionDelta } from './electronic-warfare'

// T2 第 3 批：舆论战/民心（每回合 publicWill/internationalOpinion 调整）
export {
  updatePublicWill,
  updateInternationalOpinion,
  updatePublicWillForFaction,
  updateInternationalOpinionForFaction,
  applyMutinyPenalty,
  DEFAULT_PUBLIC_WILL,
  DEFAULT_INTERNATIONAL_OPINION,
  PUBLIC_WILL_CRISIS_THRESHOLD,
  OPINION_AID_CUTOFF_THRESHOLD,
  PUBLIC_WILL_DELTAS,
} from './public-opinion'
export type {
  PublicWillDelta,
  InternationalOpinionDelta,
} from './public-opinion'

// T2 第 5 批 A：导弹拦截（防空反导判定纯函数）
export {
  resolveMissileAttack,
  findBestAirDefender,
  getAirDefenseCapability,
  computeInterceptionProb,
  MISSILE_BASE_DAMAGE,
} from './missile-defense'
export type { MissileAttackResult } from './missile-defense'

// T3-C：空海专门规则（naval-combat / air-combat 纯函数）
export {
  resolveNavalEngagement,
  resolveAirSortie,
  isCarrier,
  NAVAL_FIREPOWER_MULT,
  NAVAL_DEFENDER_AMMO_COST,
  NAVAL_ENGAGEMENT_RANGE,
  AIR_SORTIE_DAMAGE_MIN,
  AIR_SORTIE_DAMAGE_MAX,
  AIR_SORTIE_SELF_STRENGTH_COST,
} from './naval-combat'
export {
  resolveAirSuperiority,
  AIR_SUPERIORITY_LOSER_MORALE_PENALTY,
  AIR_SUPERIORITY_LOSER_STRENGTH_PENALTY,
  AIR_SUPERIORITY_WINNER_RECON_BONUS,
} from './air-combat'

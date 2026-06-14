/**
 * Agent 角色层 barrel（chief/theater/commander/director，mock + LLM 双实现）。
 *
 * - chief（mock 命令解析 + 真 LLM 解析）：createChiefRole/createLlmChiefRole
 * - theater（mock 拆解 + 真 LLM 拆解）：createTheaterRole/createLlmTheaterRole
 * - commander（mock 决策 + 真 LLM 决策）：createCommanderRole/createLlmCommanderRole
 * - director（mock 终裁 + 真 LLM 终裁）：createDirectorRole/createLlmDirectorRole
 *
 * @module layers/agents/roles
 */

export { chiefRole, createChiefRole, createLlmChiefRole } from './chief'
export type { ChiefRole, ChiefParseContext, LlmChiefRole } from './chief'
export {
  theaterRole,
  createTheaterRole,
  createLlmTheaterRole,
  theaterActionToEnvelope,
} from './theater'
export type {
  TheaterRole,
  TheaterResolveParams,
  TheaterResolveResult,
  TheaterResolvedAction,
  TheaterTaskCandidate,
  LlmTheaterRole,
} from './theater'
export {
  commanderRole,
  createCommanderRole,
  createLlmCommanderRole,
  commanderDecisionToEnvelope,
} from './commander'
export type {
  CommanderRole,
  CommanderResolveParams,
  CommanderResolveResult,
  CommanderResolvedDecision,
  LlmCommanderRole,
} from './commander'
export { directorRole, createDirectorRole, createLlmDirectorRole, createDefaultContextCompressor } from './director'
export type {
  DirectorRole,
  DirectorAdjudicateParams,
  DirectorAdjudicateResult,
  ContextCompressionOutput,
  ContextCompressor,
  LlmDirectorRole,
} from './director'
export type { LlmCallConfig } from './llm-role-base'

// 上下文压缩（M4-D，TDD §3.6 每 5 回合压缩）
export {
  CONTEXT_COMPRESSION_INTERVAL,
  CONTEXT_COMPRESSION_WINDOW,
  shouldCompressContext,
  compressionWindowStart,
  generateRuleEngineSummary,
  compressContextWithRuleEngine,
  applyContextSummary,
} from './context-compression'
export type {
  ContextSummarySource,
  ContextSummaryResult,
  CompressContextParams,
} from './context-compression'

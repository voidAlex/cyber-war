/**
 * Agent 协议层 barrel — 纯函数边界。
 *
 * protocol（context-builder / schema / parseLLMJson）是纯函数，不调 Tauri/fetch/crypto，
 * 不调 Date.now()/随机数。
 *
 * @module layers/agents/protocol
 */

export {
  buildMessages,
  estimateCacheLayers,
  buildContext,
  serializeCampaignData,
  serializeWorldSummary,
} from './context-builder'
export type {
  ContextBuilderRole,
  BuildMessagesInput,
  CacheLayerEstimate,
} from './context-builder'

export {
  parseLLMJson,
  stripMarkdownFence,
  compileSchema,
  getAgentValidator,
  createAjv,
  AGENT_OUTPUT_SCHEMAS,
  CHIEF_OUTPUT_SCHEMA,
  THEATER_OUTPUT_SCHEMA,
  COMMANDER_OUTPUT_SCHEMA,
  DIRECTOR_OUTPUT_SCHEMA,
  LlmJsonParseError,
} from './schema'
export type {
  ChiefAgentOutput,
  ChiefCandidateCommand,
  TheaterAgentOutput,
  TheaterUnitAction,
  CommanderAgentOutput,
  CommanderDecision,
  DirectorAgentOutput,
  DirectorOverride,
} from './schema'

/**
 * Agent 编排器层 barrel（确定性序分配 + 多 Agent 编排）。
 *
 * @module layers/agents/orchestrator
 */

export {
  SEQUENCE_BASE,
  makeSeed,
  seedFor,
  allocateSequences,
  allocateOne,
  withAllocatedSequence,
} from './sequence-allocator'
export type { AllocatedSequences } from './sequence-allocator'
export {
  orchestrateTurnResolution,
} from './turn-resolution'
export type {
  OrchestrateTurnResolutionParams,
  OrchestrateTurnResolutionResult,
  OrchestrationEnvelope,
} from './turn-resolution'

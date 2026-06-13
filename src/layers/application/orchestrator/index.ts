/**
 * 编排器层 barrel（副作用编排出口，非纯函数边界）。
 *
 * 导出 turn-orchestrator（回合编排）与 persist-gate（持久化门控）。
 *
 * @module layers/application/orchestrator
 */

export {
  advanceTurn,
  TURN_CANCELLED,
  TURN_PERSIST_FAILED,
} from './turn-orchestrator'
export type {
  TurnOrchestratorServices,
  AdvanceTurnResult,
} from './turn-orchestrator'
export {
  isPersistGateSatisfied,
  assertPersistGate,
} from './persist-gate'

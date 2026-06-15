/**
 * 编排器层 barrel（副作用编排出口，非纯函数边界）。
 *
 * 导出 turn-orchestrator（回合编排）+ persist-gate（持久化门控）
 * + handshake-flow（命令握手流程）。
 *
 * @module layers/application/orchestrator
 */

export {
  advanceTurn,
  resumeTurnAfterDecision,
  createDefaultResolver,
  createMultiAgentResolver,
  TURN_CANCELLED,
  TURN_PERSIST_FAILED,
} from './turn-orchestrator'
export type {
  TurnOrchestratorServices,
  AdvanceTurnResult,
  DecisionResumeHandle,
} from './turn-orchestrator'
export {
  isPersistGateSatisfied,
  assertPersistGate,
} from './persist-gate'
export {
  enterHandshake,
  submitOrder,
  lockOrders,
  canEnterHandshake,
  canSubmitNow,
  canLockNow,
  buildEnvelope,
  HandshakeError,
} from './handshake-flow'

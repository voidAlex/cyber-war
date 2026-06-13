/**
 * 状态机层 barrel（纯函数边界）。
 *
 * 导出 reducer / guard / transitions / types。
 * 纯/React 边界铁律：此目录全部为纯函数，vitest import 不得拉起任何
 * Tauri/fetch/crypto（保证领域逻辑 100% 可单测且确定性可回放）。
 *
 * @module layers/application/state-machine
 */

export { wegoReducer, createInitialContext } from './reducer'
export {
  canSubmitOrder,
  canConfirmHandshake,
  canLockOrders,
  canAdvanceTurn,
  guardAction,
  isActionAllowed,
} from './guard'
export {
  VALID_TRANSITIONS,
  isValidTransition,
  canTransition,
} from './transitions'
export type {
  StateMachineContext,
  StateMachineAction,
  ReducerResult,
  ClockFn,
  IdGenFn,
} from './types'

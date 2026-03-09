/**
 * 游戏核心模块导出
 * 
 * @module game
 */

// 状态机
export {
  wegoReducer,
  createInitialContext,
  isValidTransition,
  getPhaseDisplayName,
  getPhaseDescription,
} from './state-machine'

export type {
  StateMachineAction,
  StateMachineContext,
  ResolutionResult,
  ResolutionEvent,
} from './state-machine'

// Hook
export { useGameState } from './use-game-state'
export type { UseGameStateReturn } from './use-game-state'
export { GameStateProvider } from './game-state-context'
export { useGameStateContext } from './use-game-state-context'

export * from './engine'

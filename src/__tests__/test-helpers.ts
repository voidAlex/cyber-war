/**
 * 测试辅助（test-helpers.ts）— 构造最小合法的 StateMachineContext / WorldState。
 *
 * 仅测试用，不进入生产代码路径。reducer/guard 纯函数测试由此构造输入。
 *
 * @module __tests__/test-helpers
 */

import type { StateMachineContext } from '@/layers/application/state-machine/types'
import type { GamePhase, WorldState } from '@/types'

/**
 * 构造最小合法 WorldState（M1 空世界）。
 */
export function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    saveId: 'test-save',
    scenarioId: 'test-scenario',
    scenarioSeed: 'test-scenario:test-save',
    turnIndex: 0,
    inGameDate: 'D-0',
    factions: [],
    units: [],
    map: {
      gridType: 'square',
      cols: 0,
      rows: 0,
      cells: [],
      highValueNodes: [],
    },
    intel: {
      decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      reconHits: [],
    },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
    ...overrides,
  }
}

/**
 * 构造最小合法 StateMachineContext。
 */
export function makeContext(overrides: Partial<StateMachineContext> = {}): StateMachineContext {
  return {
    game: { phase: 'idle', world: makeWorld() },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    persisting: false,
    persistCompleted: false,
    pendingDecision: null,
    error: null,
    ...overrides,
  }
}

/**
 * 构造指定 phase 的上下文（便捷）。
 */
export function makeContextAtPhase(phase: GamePhase): StateMachineContext {
  return makeContext({ game: { phase, world: makeWorld() } })
}

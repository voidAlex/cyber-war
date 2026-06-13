/**
 * 情报衰减（intelligence）单测。
 *
 * 验证：半衰降级、残影标记、applyIntelDecay 全状态遍历、己方不衰减、recon 刷新。
 *
 * @module __tests__/domain/intelligence
 */

import { describe, expect, it } from 'vitest'
import {
  decayIntel,
  applyIntelDecay,
  decayObservation,
  refreshOnRecon,
  isStale,
  staleGhostTurns,
} from '@/layers/domain/intelligence'
import type { WorldState, Unit, IntelObservation } from '@/types'

/** 构造观测记录 */
function makeObs(overrides: Partial<IntelObservation> = {}): IntelObservation {
  return {
    observerFactionId: 'red',
    level: 3,
    lastSeenTurn: 0,
    staleTurns: 0,
    ...overrides,
  }
}

/** 构造单位 */
function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    factionId: 'blue',
    type: 'infantry',
    coord: { col: 0, row: 0 },
    strength: 100,
    personnel: 1000,
    maxPersonnel: 1000,
    fuel: 100,
    ammo: 100,
    morale: 80,
    fatigue: 0,
    detection: {},
    orders: [],
    status: [],
    ...overrides,
  }
}

/** 构造世界状态（含 intel.decayRule） */
function makeWorld(units: Unit[], turnIndex = 0): WorldState {
  return {
    saveId: 's',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex,
    inGameDate: 'D-0',
    factions: [],
    units,
    map: { gridType: 'square', cols: 0, rows: 0, cells: [], highValueNodes: [] },
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
  }
}

describe('decayIntel', () => {
  it('staleTurns=0 不降级', () => {
    expect(decayIntel(3, 0)).toBe(3)
  })

  it('未满半衰（<3）不降级', () => {
    expect(decayIntel(3, 2)).toBe(3)
  })

  it('满一个半衰（3回合）降 1 级', () => {
    expect(decayIntel(3, 3)).toBe(2)
  })

  it('两个半衰（6回合）降 2 级', () => {
    expect(decayIntel(3, 6)).toBe(1)
  })

  it('三个半衰（9回合）降到盲区 L0', () => {
    expect(decayIntel(3, 9)).toBe(0)
  })

  it('降级不低于 0', () => {
    expect(decayIntel(1, 20)).toBe(0)
  })

  it('可自定义 decayPerHalfLife', () => {
    expect(decayIntel(3, 3, 3, 2)).toBe(1) // 一次降 2 级
  })
})

describe('isStale / staleGhostTurns', () => {
  it('isStale：>=半衰为 true', () => {
    expect(isStale(3)).toBe(true)
    expect(isStale(2)).toBe(false)
  })

  it('staleGhostTurns：超过几个半衰', () => {
    expect(staleGhostTurns(2)).toBe(0)
    expect(staleGhostTurns(3)).toBe(1)
    expect(staleGhostTurns(7)).toBe(2)
  })
})

describe('decayObservation', () => {
  it('刷新 staleTurns 并降级', () => {
    const obs = makeObs({ level: 3, lastSeenTurn: 0 })
    const decayed = decayObservation(obs, 4) // currentTurn=4, stale=4 → 降1级
    expect(decayed.level).toBe(2)
    expect(decayed.staleTurns).toBe(4)
  })

  it('刚命中不降级', () => {
    const obs = makeObs({ level: 2, lastSeenTurn: 5 })
    const decayed = decayObservation(obs, 5)
    expect(decayed.level).toBe(2)
    expect(decayed.staleTurns).toBe(0)
  })

  it('不可变：不修改原记录', () => {
    const obs = makeObs({ level: 3, lastSeenTurn: 0 })
    decayObservation(obs, 9)
    expect(obs.level).toBe(3)
  })
})

describe('refreshOnRecon', () => {
  it('刷新 lastSeenTurn 并升级', () => {
    const obs = makeObs({ level: 1, lastSeenTurn: 0, staleTurns: 9 })
    const refreshed = refreshOnRecon(obs, 10, 3)
    expect(refreshed.level).toBe(3)
    expect(refreshed.lastSeenTurn).toBe(10)
    expect(refreshed.staleTurns).toBe(0)
  })

  it('不会因更低 gainedLevel 降级', () => {
    const obs = makeObs({ level: 3 })
    const refreshed = refreshOnRecon(obs, 5, 1)
    expect(refreshed.level).toBe(3)
  })
})

describe('applyIntelDecay 全状态遍历', () => {
  it('敌方观测随回合降级，己方保持 L3', () => {
    const unit = makeUnit({
      factionId: 'blue',
      detection: {
        red: makeObs({ observerFactionId: 'red', level: 3, lastSeenTurn: 0 }),
        blue: makeObs({ observerFactionId: 'blue', level: 3, lastSeenTurn: 0 }),
      },
    })
    const world = makeWorld([unit], 4)
    const [decayed] = applyIntelDecay(world, 4)
    // red 观测：stale=4 → 降 1 级 → L2
    expect(decayed.detection.red.level).toBe(2)
    expect(decayed.detection.red.staleTurns).toBe(4)
    // blue 己方：保持 L3，stale=0
    expect(decayed.detection.blue.level).toBe(3)
    expect(decayed.detection.blue.staleTurns).toBe(0)
  })

  it('不可变：返回新数组，不修改原 units', () => {
    const unit = makeUnit({
      detection: { red: makeObs({ level: 3, lastSeenTurn: 0 }) },
    })
    const world = makeWorld([unit], 0)
    const result = applyIntelDecay(world, 5)
    expect(result).not.toBe(world.units)
    expect(world.units[0].detection.red.level).toBe(3) // 原状未变
  })

  it('默认 currentTurn 取 worldState.turnIndex', () => {
    const unit = makeUnit({
      detection: { red: makeObs({ level: 3, lastSeenTurn: 2 }) },
    })
    const world = makeWorld([unit], 6) // turnIndex=6, stale=4 → L2
    const [decayed] = applyIntelDecay(world)
    expect(decayed.detection.red.level).toBe(2)
  })
})

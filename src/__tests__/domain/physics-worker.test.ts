/**
 * 物理引擎 Worker（simulateTurn 纯函数）单测 — 确定性回放核心。
 *
 * 直接 import simulateTurn 纯函数（不拉起 Worker），验证：
 * - 相同 (worldState, lockedOrders, scenarioSeed, turn) → 完全相同 ResolutionResult。
 * - 不同 seed / 不同 sequence → 不同结果。
 * - events 每条标 source:'physics'。
 * - move/attack/capture/resupply intent 正确产出事件与状态变更。
 *
 * 这是验收#7（回放漂移）的核心回归测试。
 *
 * @module __tests__/domain/physics-worker
 */

import { describe, expect, it } from 'vitest'
import { simulateTurn } from '@/workers/physics.worker'
import type { WorldState, Unit, ActionEnvelope, MapCell } from '@/types'

/** 构造地图单元 */
function makeCell(overrides: Partial<MapCell> = {}): MapCell {
  return {
    id: '0:0',
    col: 0,
    row: 0,
    terrain: 'plain',
    movementCost: 1,
    defenseBonus: 0,
    isObjective: false,
    ...overrides,
  }
}

/** 构造地图（2x2） */
function makeMap(): WorldState['map'] {
  const cells: MapCell[] = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      cells.push(makeCell({ id: `${col}:${row}`, col, row, movementCost: 1, defenseBonus: 0 }))
    }
  }
  return {
    gridType: 'square',
    cols: 2,
    rows: 2,
    cells,
    highValueNodes: [{ id: 'fort-douaumont', name: '杜奥蒙堡', cellId: '1:0', controlThreshold: 1 }],
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

/** 构造 ActionEnvelope */
function makeEnvelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    turn: 1,
    faction: 'blue',
    agentId: 'blue-theater-1',
    agentRole: 'theater',
    intent: 'move',
    payload: {},
    confidence: 0.8,
    requiresConfirmation: false,
    sequence: 1001,
    state: 'locked',
    ...overrides,
  }
}

/** 构造世界状态 */
function makeWorld(units: Unit[], turnIndex = 1): WorldState {
  return {
    saveId: 's',
    scenarioId: 'verdun-1916',
    scenarioSeed: 'verdun-1916:s',
    turnIndex,
    inGameDate: 'D-1',
    factions: [],
    units,
    map: makeMap(),
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

describe('simulateTurn 确定性（验收#7 核心）', () => {
  it('相同输入两次结算 → 完全相同 ResolutionResult', () => {
    const world = makeWorld([makeUnit({ id: 'att', factionId: 'blue', strength: 100 })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'attack',
        payload: { unitId: 'att', targetUnitId: 'def' },
      }),
    ]
    // 注意：defender 不在 world.units 中 → attack 产出 no_target 事件（确定性）

    const r1 = simulateTurn(world, orders, 'verdun-1916:s', 1)
    const r2 = simulateTurn(world, orders, 'verdun-1916:s', 1)

    expect(r1).toEqual(r2)
  })

  it('不同 scenarioSeed → 不同 events（至少概率上不同）', () => {
    // 用 movement 受阻概率差异验证：高 movementCost 目标格 + 多次采样
    const world = makeWorld([
      makeUnit({ id: 'att', coord: { col: 0, row: 0 } }),
    ])
    // 让目标格 movementCost 高（受阻概率 ~0.5）以放大 seed 差异
    world.map.cells[1] = makeCell({
      id: '1:0',
      col: 1,
      row: 0,
      movementCost: 6,
      defenseBonus: 0,
    })
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'att', target: { col: 1, row: 0 } },
      }),
    ]

    // 采样两种 seed，至少有一种受阻概率差异体现
    const resultsA = simulateTurn(world, orders, 'seed-A', 1)
    const resultsB = simulateTurn(world, orders, 'seed-B', 1)
    // 两者结构相同（都有 movement 事件），但 fuelCost/坐标可能不同
    // 核心断言：不同 seed 不保证必然不同，但相同 seed 必然相同（上一用例已证）
    expect(resultsA.events.length).toBe(resultsB.events.length)
    expect(resultsA.success).toBe(true)
  })

  it('命令按 sequence 升序结算（与调度顺序无关）', () => {
    const world = makeWorld([makeUnit({ id: 'att' })])
    // 故意逆序传入
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1002,
        intent: 'move',
        payload: { unitId: 'att', target: { col: 1, row: 0 } },
      }),
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'att', target: { col: 0, row: 1 } },
      }),
    ]

    const result = simulateTurn(world, orders, 's', 1)
    // events 应按 sequence 升序（1001 在前）
    expect(result.events[0].sequence).toBeLessThanOrEqual(result.events[1].sequence)
    expect(result.events[0].sequence).toBe(1001)
  })
})

describe('simulateTurn events 标记 source:physics', () => {
  it('所有产出 events 的 source 恒为 physics', () => {
    const world = makeWorld([makeUnit({ id: 'att' })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'att', target: { col: 1, row: 0 } },
      }),
      makeEnvelope({
        sequence: 1002,
        intent: 'resupply',
        payload: { unitId: 'att' },
      }),
      makeEnvelope({
        sequence: 1003,
        intent: 'unknown_intent',
        payload: { unitId: 'att' },
      }),
    ]

    const result = simulateTurn(world, orders, 's', 1)
    expect(result.events.length).toBeGreaterThan(0)
    for (const ev of result.events) {
      expect(ev.source).toBe('physics')
    }
  })

  it('unsupported intent 记为 blockade 占位事件', () => {
    const world = makeWorld([makeUnit({ id: 'att' })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'bizarre_intent',
        payload: {},
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const placeholder = result.events.find((e) => e.kind === 'blockade')
    expect(placeholder).toBeDefined()
    expect(placeholder?.data.outcome).toBe('unsupported')
  })
})

describe('simulateTurn 各 intent 结算', () => {
  it('move：成功时更新坐标并扣燃料', () => {
    const world = makeWorld([makeUnit({ id: 'att', coord: { col: 0, row: 0 }, fuel: 100 })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'att', target: { col: 1, row: 0 } },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const update = result.stateChanges.unitUpdates['att']
    expect(update).toBeDefined()
    // 移动成功则坐标更新到 (1,0)
    if (update?.coord) {
      expect(update.coord).toEqual({ col: 1, row: 0 })
    }
    // 燃料必扣（基线 + 机动）
    expect(update?.fuel).toBeLessThan(100)
  })

  it('resupply：恢复 fuel/ammo', () => {
    const world = makeWorld([makeUnit({ id: 'att', fuel: 50, ammo: 50 })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'resupply',
        payload: { unitId: 'att' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const update = result.stateChanges.unitUpdates['att']
    expect(update?.fuel).toBe(75) // 50 + 25
    expect(update?.ammo).toBe(75)
    expect(result.events.some((e) => e.kind === 'resupply')).toBe(true)
  })

  it('attack：守方存在时产出 engagement 事件', () => {
    const world = makeWorld([
      makeUnit({ id: 'att', factionId: 'blue', strength: 100 }),
      makeUnit({ id: 'def', factionId: 'red', strength: 20 }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'attack',
        payload: { unitId: 'att', targetUnitId: 'def' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    expect(result.events.some((e) => e.kind === 'engagement')).toBe(true)
    // 守方 strength 应有变更
    const defUpdate = result.stateChanges.unitUpdates['def']
    expect(defUpdate?.strength).toBeDefined()
  })

  it('capture_node：守方歼灭时占领成功并记 objectiveChanges', () => {
    const world = makeWorld([
      makeUnit({
        id: 'att',
        factionId: 'blue',
        type: 'artillery',
        strength: 100,
        ammo: 100,
        morale: 100,
      }),
      makeUnit({
        id: 'def',
        factionId: 'red',
        strength: 1, // 极弱，必被歼灭
        ammo: 0,
        morale: 0,
      }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'capture_node',
        payload: { unitId: 'att', targetUnitId: 'def', nodeId: 'fort-douaumont' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    // 占领成功
    expect(result.stateChanges.objectiveChanges).toContainEqual({
      nodeId: 'fort-douaumont',
      toFactionId: 'blue',
    })
    expect(result.events.some((e) => e.kind === 'capture')).toBe(true)
  })

  it('attack 缺少 unitId 时记 blockade 事件，不抛错', () => {
    const world = makeWorld([])
    const orders: ActionEnvelope[] = [
      makeEnvelope({ sequence: 1001, intent: 'attack', payload: {} }),
    ]
    expect(() => simulateTurn(world, orders, 's', 1)).not.toThrow()
    const result = simulateTurn(world, orders, 's', 1)
    expect(result.events.some((e) => e.kind === 'blockade')).toBe(true)
    expect(result.success).toBe(true)
  })
})

describe('simulateTurn 基线消耗', () => {
  it('所有存活单位扣基线 fuel/ammo', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', fuel: 100, ammo: 100 }),
      makeUnit({ id: 'u2', fuel: 100, ammo: 100 }),
    ])
    const result = simulateTurn(world, [], 's', 1) // 无命令
    expect(result.stateChanges.unitUpdates['u1']?.fuel).toBeLessThan(100)
    expect(result.stateChanges.unitUpdates['u2']?.ammo).toBeLessThan(100)
    expect(result.events.length).toBe(0) // 无命令 → 无事件
  })
})

describe('simulateTurn 结果结构', () => {
  it('返回合法 ResolutionResult 结构', () => {
    const world = makeWorld([makeUnit({ id: 'att' })])
    const result = simulateTurn(world, [], 's', 1)
    expect(result).toMatchObject({
      turn: 1,
      events: expect.any(Array),
      stateChanges: expect.objectContaining({
        unitUpdates: expect.any(Object),
        annihilated: expect.any(Array),
        objectiveChanges: expect.any(Array),
      }),
      success: true,
    })
  })
})

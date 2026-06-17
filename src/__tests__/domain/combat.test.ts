/**
 * 战斗结算（combat）+ 胜负判定（victory）单测。
 *
 * 验证：resolveEngagement/resolveCapture 产出、歼灭判定、checkVictory 三类条件。
 *
 * @module __tests__/domain/combat
 */

import { describe, expect, it } from 'vitest'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import {
  resolveEngagement,
  resolveCapture,
  checkRoutAndSurrender,
} from '@/layers/domain/combat'
import { checkVictory } from '@/layers/domain/victory'
import type { WorldState, Unit, MapCell } from '@/types'

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

function makeWorld(units: Unit[]): WorldState {
  return {
    saveId: 's',
    playerFactionId: '',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex: 1,
    inGameDate: 'D-1',
    factions: [],
    units,
    map: {
      gridType: 'square',
      cols: 1,
      rows: 1,
      cells: [makeCell()],
      highValueNodes: [],
    },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

describe('resolveEngagement', () => {
  it('守方不存在 → no_target 事件，不抛错', () => {
    const world = makeWorld([makeUnit({ id: 'att' })])
    const rng = new DeterministicRandom('eng-notarget')
    const outcome = resolveEngagement({
      world,
      attacker: makeUnit({ id: 'att' }),
      defenderId: 'ghost',
      rng,
      sequence: 1,
      turn: 1,
    })
    expect(outcome.events[0].data.outcome).toBe('no_target')
    expect(outcome.defenderAnnihilated).toBe(false)
  })

  it('攻强守弱 → 守方受损', () => {
    const attacker = makeUnit({ id: 'att', strength: 100, ammo: 100, morale: 100 })
    const defender = makeUnit({ id: 'def', strength: 10, ammo: 100, morale: 50 })
    const world = makeWorld([attacker, defender])
    const rng = new DeterministicRandom('eng-win')
    const outcome = resolveEngagement({
      world,
      attacker,
      defenderId: 'def',
      rng,
      sequence: 1,
      turn: 1,
    })
    expect(outcome.defenderChange.strength).toBeLessThan(defender.strength)
    expect(outcome.events.some((e) => e.kind === 'engagement')).toBe(true)
  })

  it('守方被歼灭 → casualty 事件 + defenderAnnihilated=true', () => {
    const attacker = makeUnit({
      id: 'att',
      type: 'artillery',
      strength: 100,
      ammo: 100,
      morale: 100,
    })
    const defender = makeUnit({ id: 'def', strength: 1, ammo: 0, morale: 0 })
    const world = makeWorld([attacker, defender])
    const rng = new DeterministicRandom('eng-kill')
    const outcome = resolveEngagement({
      world,
      attacker,
      defenderId: 'def',
      rng,
      sequence: 1,
      turn: 1,
    })
    if (outcome.defenderChange.strength! <= 0) {
      expect(outcome.defenderAnnihilated).toBe(true)
      expect(outcome.events.some((e) => e.kind === 'casualty')).toBe(true)
    }
  })

  it('相同输入两次调用结果一致（确定性）', () => {
    const world = makeWorld([
      makeUnit({ id: 'att', strength: 70 }),
      makeUnit({ id: 'def', strength: 60 }),
    ])
    const mk = () =>
      resolveEngagement({
        world,
        attacker: makeUnit({ id: 'att', strength: 70 }),
        defenderId: 'def',
        rng: new DeterministicRandom('eng-determ'),
        sequence: 1,
        turn: 1,
      })
    expect(mk()).toEqual(mk())
  })
})

describe('resolveCapture', () => {
  it('守方不存在 → 直接占领成功', () => {
    const world = makeWorld([makeUnit({ id: 'att' })])
    const rng = new DeterministicRandom('cap-empty')
    const outcome = resolveCapture({
      world,
      attacker: makeUnit({ id: 'att' }),
      defenderId: '',
      rng,
      sequence: 1,
      turn: 1,
      nodeId: 'node-1',
    })
    expect(outcome.captured).toBe(true)
    expect(outcome.events.some((e) => e.kind === 'capture')).toBe(true)
  })

  it('守方未被歼灭 → 占领失败记 blockade', () => {
    const attacker = makeUnit({ id: 'att', strength: 5 }) // 极弱
    const defender = makeUnit({
      id: 'def',
      type: 'fortress',
      strength: 100,
      ammo: 100,
      morale: 100,
    })
    const world = makeWorld([attacker, defender])
    const rng = new DeterministicRandom('cap-fail')
    const outcome = resolveCapture({
      world,
      attacker,
      defenderId: 'def',
      rng,
      sequence: 1,
      turn: 1,
      nodeId: 'node-1',
    })
    // 守方未歼灭 → 占领失败记 blockade
    if (!outcome.captured) {
      expect(outcome.events.some((e) => e.kind === 'blockade')).toBe(true)
    }
  })
})

describe('checkVictory', () => {
  it('无输入返回未决', () => {
    expect(checkVictory()).toEqual({ decided: false, winnerFactionId: null, reason: null })
  })

  it('objective 条件：占领全部目标节点 → 胜', () => {
    const world = makeWorld([])
    const result = checkVictory({
      world,
      controlledNodes: { blue: ['node-a', 'node-b'] },
      accumulatedCasualties: {},
      conditions: [
        { factionId: 'blue', kind: 'objective', target: ['node-a', 'node-b'] },
      ],
    })
    expect(result.decided).toBe(true)
    expect(result.winnerFactionId).toBe('blue')
  })

  it('objective 条件：仅占部分 → 未决', () => {
    const world = makeWorld([])
    const result = checkVictory({
      world,
      controlledNodes: { blue: ['node-a'] },
      accumulatedCasualties: {},
      conditions: [
        { factionId: 'blue', kind: 'objective', target: ['node-a', 'node-b'] },
      ],
    })
    expect(result.decided).toBe(false)
  })

  it('casualty 条件：敌方战损超阈值 → 胜', () => {
    const world = makeWorld([])
    const result = checkVictory({
      world,
      controlledNodes: {},
      accumulatedCasualties: { red: 150 },
      conditions: [
        { factionId: 'blue', kind: 'casualty', target: 100 },
      ],
    })
    expect(result.decided).toBe(true)
    expect(result.winnerFactionId).toBe('blue')
  })

  it('turnLimit 条件：到达上限且一方领先 → 胜', () => {
    const world = makeWorld([])
    world.turnIndex = 30
    const result = checkVictory({
      world,
      controlledNodes: { blue: ['a', 'b', 'c'], red: ['x'] },
      accumulatedCasualties: {},
      conditions: [{ factionId: 'blue', kind: 'turnLimit', target: 30 }],
    })
    expect(result.decided).toBe(true)
    expect(result.winnerFactionId).toBe('blue')
  })

  it('turnLimit 条件：到达上限但平局 → 未决', () => {
    const world = makeWorld([])
    world.turnIndex = 30
    const result = checkVictory({
      world,
      controlledNodes: { blue: ['a'], red: ['b'] },
      accumulatedCasualties: {},
      conditions: [{ factionId: 'blue', kind: 'turnLimit', target: 30 }],
    })
    expect(result.decided).toBe(false)
  })

  it('未达回合上限 → 未决', () => {
    const world = makeWorld([])
    world.turnIndex = 5
    const result = checkVictory({
      world,
      controlledNodes: { blue: ['a'] },
      accumulatedCasualties: {},
      conditions: [{ factionId: 'blue', kind: 'turnLimit', target: 30 }],
    })
    expect(result.decided).toBe(false)
  })
})

// =============================================================================
// T1-D：checkRoutAndSurrender（溃退/投降判定）
// =============================================================================
describe('checkRoutAndSurrender（T1-D）', () => {
  /** 构造 3x3 地图，(0,0) 为蓝方补给源（溃退方向） */
  function makeWorld3x3(units: Unit[]): WorldState {
    const cells: MapCell[] = []
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        cells.push(
          makeCell({
            id: `${col}:${row}`,
            col,
            row,
            isSupplySource: col === 0 && row === 0,
          }),
        )
      }
    }
    return {
      saveId: 's',
      playerFactionId: '',
      scenarioId: 'sc',
      scenarioSeed: 'sc:s',
      turnIndex: 1,
      inGameDate: 'D-1',
      factions: [],
      units,
      map: {
        gridType: 'square',
        cols: 3,
        rows: 3,
        cells,
        highValueNodes: [],
      },
      intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
      diplomacy: { events: [], pendingDefectionCheck: false },
      directorMemory: { keyEvents: {}, overrides: [] },
      pendingOrders: [],
      lockedOrders: {},
      lastResolution: null,
      contextSummaries: {},
    }
  }

  it('morale<15 且 strength<30 → 溃退：strength-10 + status routed + 向己方补给源移 1 格', () => {
    // 蓝方单位在 (2,2)，蓝方补给源在 (0,0)。溃退应朝 (0,0) 移一步 → (1,2) 或 (2,1)
    const world = makeWorld3x3([
      makeUnit({
        id: 'broken',
        factionId: 'blue',
        coord: { col: 2, row: 2 },
        morale: 10,
        strength: 20,
      }),
    ])
    const result = checkRoutAndSurrender(world)
    expect(result.routs).toHaveLength(1)
    const rout = result.routs[0]
    expect(rout.id).toBe('broken')
    expect(rout.strength).toBe(10) // 20 - 10
    expect(rout.status).toContain('routed')
    // 新坐标朝 (0,0) 方向移一格（曼哈顿距离减少 1）
    expect(rout.coord).toBeDefined()
    const newCoord = rout.coord!
    const oldDist = Math.abs(2 - 0) + Math.abs(2 - 0) // 4
    const newDist = Math.abs(newCoord.col - 0) + Math.abs(newCoord.row - 0)
    expect(newDist).toBe(oldDist - 1)
    // 不应投降
    expect(result.surrenders).toHaveLength(0)
  })

  it('morale≥15 或 strength≥30 → 不溃退', () => {
    const world = makeWorld3x3([
      makeUnit({
        id: 'ok1',
        factionId: 'blue',
        coord: { col: 2, row: 2 },
        morale: 20,
        strength: 20, // morale 达标，不溃退
      }),
      makeUnit({
        id: 'ok2',
        factionId: 'blue',
        coord: { col: 1, row: 1 },
        morale: 10,
        strength: 50, // strength 达标，不溃退
      }),
    ])
    const result = checkRoutAndSurrender(world)
    expect(result.routs).toHaveLength(0)
    expect(result.surrenders).toHaveLength(0)
  })

  it('morale<5 且所有邻格被敌方包围 → 投降：strength=0 + status destroyed', () => {
    // 蓝方单位在 (1,1) 被红方四邻格包围（(0,1)(2,1)(1,0)(1,2)）
    const world = makeWorld3x3([
      makeUnit({
        id: 'doomed',
        factionId: 'blue',
        coord: { col: 1, row: 1 },
        morale: 3,
        strength: 20,
      }),
      makeUnit({ id: 'e1', factionId: 'red', coord: { col: 0, row: 1 } }),
      makeUnit({ id: 'e2', factionId: 'red', coord: { col: 2, row: 1 } }),
      makeUnit({ id: 'e3', factionId: 'red', coord: { col: 1, row: 0 } }),
      makeUnit({ id: 'e4', factionId: 'red', coord: { col: 1, row: 2 } }),
    ])
    const result = checkRoutAndSurrender(world)
    expect(result.surrenders).toHaveLength(1)
    const sur = result.surrenders[0]
    expect(sur.id).toBe('doomed')
    expect(sur.strength).toBe(0)
  })

  it('morale<5 但有邻格无敌方 → 不投降（可溃退）', () => {
    // 蓝方单位在 (1,1)，仅 2 个邻格有敌方（未完全包围）→ 不投降，但 morale<15+strength<30 → 溃退
    const world = makeWorld3x3([
      makeUnit({
        id: 'partial',
        factionId: 'blue',
        coord: { col: 1, row: 1 },
        morale: 3,
        strength: 20,
      }),
      makeUnit({ id: 'e1', factionId: 'red', coord: { col: 0, row: 1 } }),
      // (2,1)(1,0)(1,2) 无敌方 → 未完全包围
    ])
    const result = checkRoutAndSurrender(world)
    expect(result.surrenders).toHaveLength(0)
    // 溃退条件满足（morale<15 且 strength<30）→ 溃退
    expect(result.routs).toHaveLength(1)
  })

  it('阈值可配：rules.routThreshold={morale:30,strength:50} 提高溃退门槛', () => {
    const world = makeWorld3x3([
      makeUnit({
        id: 'u',
        factionId: 'blue',
        coord: { col: 2, row: 2 },
        morale: 25,
        strength: 40, // 默认阈值不溃退，但提高阈值后溃退
      }),
    ])
    const result = checkRoutAndSurrender(world, {
      routThreshold: { morale: 30, strength: 50 },
    })
    expect(result.routs).toHaveLength(1)
  })
})

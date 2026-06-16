/**
 * applyResolutionStateChanges 单测 — Bug1/2/4 核心根因修复的回归保护。
 *
 * 根因：内存实时路径（turn-orchestrator）原仅 applyResolutionToIntel（仅 detection），
 * 数值字段（coord/strength/morale/fatigue/...）从不落地 → 单位坐标永远不变（Bug1）、
 * hold 数值不生效（Bug2）、侦查数值看不到（Bug4）。本函数补齐完整 apply，
 * 与回放路径 replay.commitStateChanges 语义对齐。
 *
 * 验证：
 * - coord/strength/morale/fatigue/fuel/ammo/status 全字段落地。
 * - detection 增量合并（recon 命中，level 不降）。
 * - 歼灭单位从 world.units 移除。
 * - reconHits 追加到 world.intel.reconHits（turn 填结算回合）。
 * - 无变更时返回原 world（引用相等，避免无谓拷贝）。
 * - 不可变：入参 world 不被修改。
 *
 * @module __tests__/domain/apply-resolution
 */

import { describe, expect, it } from 'vitest'
import { applyResolutionStateChanges } from '@/layers/domain/combat'
import type { CombatStateChanges } from '@/layers/domain/combat'
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
  const cells: MapCell[] = []
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      cells.push(makeCell({ id: `${col}:${row}`, col, row }))
    }
  }
  return {
    saveId: 's',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex: 1,
    inGameDate: 'D-1',
    factions: [],
    units,
    map: { gridType: 'square', cols: 2, rows: 2, cells, highValueNodes: [] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

function makeStateChanges(overrides: Partial<CombatStateChanges> = {}): CombatStateChanges {
  return {
    unitUpdates: {},
    annihilated: [],
    objectiveChanges: [],
    ...overrides,
  }
}

describe('applyResolutionStateChanges — Bug1/2/4 核心根因修复', () => {
  it('Bug1：coord 落地到 world.units（单位坐标真正回写）', () => {
    const world = makeWorld([makeUnit({ id: 'mover', coord: { col: 0, row: 0 } })])
    const sc = makeStateChanges({
      unitUpdates: {
        mover: { coord: { col: 1, row: 1 }, fuel: 90 },
      },
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    expect(next.units[0].coord).toEqual({ col: 1, row: 1 })
    expect(next.units[0].fuel).toBe(90)
  })

  it('Bug2：morale/fatigue 落地（hold 固守数值生效）', () => {
    const world = makeWorld([makeUnit({ id: 'holder', morale: 50, fatigue: 40 })])
    const sc = makeStateChanges({
      unitUpdates: { holder: { morale: 52, fatigue: 37 } },
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    expect(next.units[0].morale).toBe(52)
    expect(next.units[0].fatigue).toBe(37)
  })

  it('Bug4：detection 增量合并（recon 命中后 level 升级，敌方可见）', () => {
    const world = makeWorld([
      makeUnit({ id: 'enemy', factionId: 'red', detection: {} }),
    ])
    const sc = makeStateChanges({
      unitUpdates: {
        enemy: {
          detection: {
            blue: { observerFactionId: 'blue', level: 2, lastSeenTurn: 1, staleTurns: 0 },
          },
        },
      },
      intelReconHits: [{ observerFactionId: 'blue', unitId: 'enemy' }],
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    // detection 合并：blue 观测记录写入，level=2（L2 编制确认，沙盘可见）
    expect(next.units[0].detection['blue']).toEqual({
      observerFactionId: 'blue',
      level: 2,
      lastSeenTurn: 1,
      staleTurns: 0,
    })
    // reconHits 追加，turn 填结算回合
    expect(next.intel.reconHits).toEqual([
      { turn: 1, observerFactionId: 'blue', unitId: 'enemy' },
    ])
  })

  it('全字段落地（strength/personnel/fuel/ammo/status）', () => {
    const world = makeWorld([makeUnit({ id: 'u', strength: 100, personnel: 1000, fuel: 100, ammo: 100, status: [] })])
    const sc = makeStateChanges({
      unitUpdates: {
        u: { strength: 70, personnel: 700, fuel: 50, ammo: 40, status: ['engaged'] },
      },
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    expect(next.units[0].strength).toBe(70)
    expect(next.units[0].personnel).toBe(700)
    expect(next.units[0].fuel).toBe(50)
    expect(next.units[0].ammo).toBe(40)
    expect(next.units[0].status).toEqual(['engaged'])
  })

  it('歼灭单位从 world.units 移除', () => {
    const world = makeWorld([
      makeUnit({ id: 'alive' }),
      makeUnit({ id: 'dead' }),
    ])
    const sc = makeStateChanges({
      unitUpdates: { dead: { strength: 0 } },
      annihilated: ['dead'],
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    expect(next.units.map((u) => u.id)).toEqual(['alive'])
  })

  it('无变更时返回原 world（引用相等，避免无谓拷贝）', () => {
    const world = makeWorld([makeUnit({ id: 'u' })])
    const sc = makeStateChanges() // 空
    const next = applyResolutionStateChanges(world, sc, 1)
    expect(next).toBe(world) // 同一引用
  })

  it('不可变：入参 world 不被修改', () => {
    const world = makeWorld([makeUnit({ id: 'u', coord: { col: 0, row: 0 } })])
    const originalCoord = { ...world.units[0].coord }
    const sc = makeStateChanges({
      unitUpdates: { u: { coord: { col: 1, row: 1 } } },
    })
    applyResolutionStateChanges(world, sc, 1)
    // 入参 world 的单位坐标应保持不变（不可变产出）
    expect(world.units[0].coord).toEqual(originalCoord)
  })

  it('detection 合并不覆盖既有其他观察方记录', () => {
    const world = makeWorld([
      makeUnit({
        id: 'enemy',
        factionId: 'red',
        detection: {
          blue: { observerFactionId: 'blue', level: 1, lastSeenTurn: 0, staleTurns: 1 },
          green: { observerFactionId: 'green', level: 3, lastSeenTurn: 1, staleTurns: 0 },
        },
      }),
    ])
    const sc = makeStateChanges({
      unitUpdates: {
        enemy: {
          detection: {
            blue: { observerFactionId: 'blue', level: 2, lastSeenTurn: 1, staleTurns: 0 }, // 只升级 blue
          },
        },
      },
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    // blue 升级，green 保持不变（不被清空）
    expect(next.units[0].detection['blue'].level).toBe(2)
    expect(next.units[0].detection['green'].level).toBe(3)
  })

  it('数值变更 + detection + 歼灭 + reconHits 同时存在（完整 apply）', () => {
    const world = makeWorld([
      makeUnit({ id: 'mover', factionId: 'blue', coord: { col: 0, row: 0 }, morale: 50 }),
      makeUnit({ id: 'enemy', factionId: 'red', coord: { col: 1, row: 1 }, detection: {} }),
      makeUnit({ id: 'victim', factionId: 'red' }),
    ])
    const sc = makeStateChanges({
      unitUpdates: {
        mover: { coord: { col: 1, row: 0 }, morale: 52 },
        enemy: {
          detection: {
            blue: { observerFactionId: 'blue', level: 2, lastSeenTurn: 1, staleTurns: 0 },
          },
        },
      },
      annihilated: ['victim'],
      intelReconHits: [{ observerFactionId: 'blue', unitId: 'enemy' }],
    })
    const next = applyResolutionStateChanges(world, sc, 1)
    expect(next.units.map((u) => u.id).sort()).toEqual(['enemy', 'mover'])
    expect(next.units.find((u) => u.id === 'mover')!.coord).toEqual({ col: 1, row: 0 })
    expect(next.units.find((u) => u.id === 'enemy')!.detection['blue'].level).toBe(2)
    expect(next.intel.reconHits).toHaveLength(1)
  })
})

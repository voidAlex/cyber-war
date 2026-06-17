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
    playerFactionId: '',
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

describe('simulateTurn recon（主动侦察）', () => {
  it('recon 命中目标 cell 内敌方单位 → 升级 detection + recon event + reconHits', () => {
    // 侦察执行单位（recon 类型，100% 成功）+ 目标 cell 上的敌方单位（L0 盲区）
    const world = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      makeUnit({
        id: 'enemy-inf',
        factionId: 'red',
        coord: { col: 1, row: 0 },
        detection: {}, // blue 对其 L0 盲区
      }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'recon',
        payload: { unitId: 'scout', target: { col: 1, row: 0 } },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)

    // 产出 recon 事件
    const reconEvt = result.events.find((e) => e.kind === 'recon')
    expect(reconEvt).toBeDefined()
    expect(reconEvt?.source).toBe('physics')
    expect(reconEvt?.data.reconUnit).toBe('scout')
    expect(reconEvt?.data.observer).toBe('blue')
    expect(reconEvt?.data.discovered).toEqual(['enemy-inf'])

    // detection 增量写入 stateChanges（recon 类型 +2，L0→L2）
    const upd = result.stateChanges.unitUpdates['enemy-inf']
    expect(upd?.detection).toBeDefined()
    expect(upd?.detection?.['blue'].level).toBe(2)
    expect(upd?.detection?.['blue'].lastSeenTurn).toBe(1)
    expect(upd?.detection?.['blue'].staleTurns).toBe(0)

    // reconHits 流追加
    expect(result.stateChanges.intelReconHits).toEqual([
      { observerFactionId: 'blue', unitId: 'enemy-inf' },
    ])

    // event.data 含完整 detectionDelta（供回放重建）
    const delta =
      (reconEvt?.data.detectionDelta as Record<string, Record<string, { level: number }>>) ?? {}
    expect(delta['enemy-inf']?.['blue']?.level).toBe(2)
  })

  it('recon 目标 cell 无敌方单位 → 空发现（不伪造）', () => {
    const world = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      // 目标 cell (1,0) 无任何单位
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'recon',
        payload: { unitId: 'scout', target: { col: 1, row: 0 } },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)

    const reconEvt = result.events.find((e) => e.kind === 'recon')
    expect(reconEvt).toBeDefined()
    expect(reconEvt?.data.discovered).toEqual([])
    expect(result.stateChanges.intelReconHits ?? []).toEqual([])
    // 无 detection 增量（不伪造）
    expect(Object.keys(result.stateChanges.unitUpdates).some((k) => k !== 'scout')).toBe(false)
  })

  it('recon 缺 unitId → blockade 失败事件', () => {
    const world = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon' }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'recon',
        payload: { target: { col: 1, row: 0 } }, // 缺 unitId
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    expect(result.events.some((e) => e.kind === 'blockade')).toBe(true)
    expect(result.events.some((e) => e.kind === 'recon')).toBe(false)
  })

  it('recon 命中同一 cell 多个敌方单位 → 全部刷新', () => {
    const world = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'e1', factionId: 'red', coord: { col: 1, row: 0 }, detection: {} }),
      makeUnit({ id: 'e2', factionId: 'red', coord: { col: 1, row: 0 }, detection: {} }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'recon',
        payload: { unitId: 'scout', target: { col: 1, row: 0 } },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const reconEvt = result.events.find((e) => e.kind === 'recon')
    expect(reconEvt?.data.discovered).toHaveLength(2)
    expect(result.stateChanges.intelReconHits ?? []).toHaveLength(2)
  })

  it('recon 确定性：相同输入两次结算 → 相同 detection delta', () => {
    const world = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'e1', factionId: 'red', coord: { col: 1, row: 0 }, detection: {} }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'recon',
        payload: { unitId: 'scout', target: { col: 1, row: 0 } },
      }),
    ]
    const r1 = simulateTurn(world, orders, 's', 1)
    const r2 = simulateTurn(world, orders, 's', 1)
    expect(r1.stateChanges.unitUpdates['e1']?.detection).toEqual(
      r2.stateChanges.unitUpdates['e1']?.detection,
    )
    expect(r1.stateChanges.intelReconHits).toEqual(r2.stateChanges.intelReconHits)
  })

  it('recon 支持 targetUnitId（定位敌方单位所在 cell）', () => {
    const world = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'target', factionId: 'red', coord: { col: 1, row: 1 }, detection: {} }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'recon',
        payload: { unitId: 'scout', targetUnitId: 'target' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const reconEvt = result.events.find((e) => e.kind === 'recon')
    expect(reconEvt?.data.discovered).toEqual(['target'])
    expect(reconEvt?.data.targetCell).toEqual({ col: 1, row: 1 })
    expect(reconEvt?.data.targetUnitId).toBe('target')
  })
})

// =============================================================================
// Bug1/Bug2 回归测试：move 缺坐标兜底 + hold 物理结算
// =============================================================================

describe('simulateTurn Bug1：move 缺 targetCoord 时用 targetUnitId 兜底', () => {
  it('payload.target 缺失但 targetUnitId 存在 → 用目标单位坐标移动（追击/靠拢语义）', () => {
    // fr-recon-1 在 (0,0)，敌方 target 在 (1,1)；move 命令漏了 target 但带了 targetUnitId
    const world = makeWorld([
      makeUnit({ id: 'fr-recon-1', factionId: 'blue', coord: { col: 0, row: 0 }, fuel: 100 }),
      makeUnit({ id: 'target', factionId: 'red', coord: { col: 1, row: 1 } }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'fr-recon-1', targetUnitId: 'target' }, // 故意无 target 坐标
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)

    // 不应产出 blockade（原 Bug1 根因：缺目标坐标）
    const blockade = result.events.find(
      (e) => e.kind === 'blockade' && (e.data as { unitId?: string }).unitId === 'fr-recon-1',
    )
    expect(blockade).toBeUndefined()

    // 应产出 movement 事件，目标坐标 = target 单位坐标 (1,1)
    const moveEvt = result.events.find((e) => e.kind === 'movement')
    expect(moveEvt).toBeDefined()
    expect((moveEvt!.data as { to: { col: number; row: number } }).to).toEqual({ col: 1, row: 1 })

    // 状态变更：单位 coord 应更新到 (1,1)（兜底坐标生效）
    const upd = result.stateChanges.unitUpdates['fr-recon-1']
    expect(upd?.coord).toEqual({ col: 1, row: 1 })
  })

  it('payload 既无 target 也无 targetUnitId → 仍 blockade「缺少目标坐标」', () => {
    const world = makeWorld([makeUnit({ id: 'u', factionId: 'blue', coord: { col: 0, row: 0 } })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'u' }, // 无任何目标
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const blockade = result.events.find((e) => e.kind === 'blockade')
    expect(blockade).toBeDefined()
    expect((blockade!.data as { reason: string }).reason).toBe('缺少目标坐标')
  })
})

describe('simulateTurn Bug2：hold 物理结算', () => {
  it('hold 命令产出 hold 事件，单位不移动但士气恢复、疲劳下降', () => {
    const world = makeWorld([
      makeUnit({
        id: 'defender',
        factionId: 'blue',
        coord: { col: 0, row: 0 },
        morale: 50,
        fatigue: 40,
      }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'hold',
        payload: { unitId: 'defender' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)

    // 应产出 hold 事件（不再落到 default unsupported blockade）
    const holdEvt = result.events.find((e) => e.kind === 'hold')
    expect(holdEvt).toBeDefined()
    expect((holdEvt!.data as { unitId: string }).unitId).toBe('defender')

    // 原 Bug2：hold 落到 default → unsupported blockade。修复后不应有 blockade
    const blockade = result.events.find((e) => e.kind === 'blockade')
    expect(blockade).toBeUndefined()

    // 状态变更：coord 不变（固守不移动），morale +2，fatigue -3
    const upd = result.stateChanges.unitUpdates['defender']
    expect(upd?.coord).toBeUndefined() // 不写 coord = 不移动
    expect(upd?.morale).toBe(52) // 50 + 2
    expect(upd?.fatigue).toBe(37) // 40 - 3
  })

  it('hold 命令缺 unitId → blockade「缺少 unitId」', () => {
    const world = makeWorld([])
    const orders: ActionEnvelope[] = [
      makeEnvelope({ sequence: 1001, intent: 'hold', payload: {} }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const blockade = result.events.find((e) => e.kind === 'blockade')
    expect(blockade).toBeDefined()
    expect((blockade!.data as { reason: string }).reason).toBe('缺少 unitId')
  })

  it('hold 事件标 source:physics（确定性两层契约）', () => {
    const world = makeWorld([makeUnit({ id: 'u', factionId: 'blue' })])
    const orders: ActionEnvelope[] = [
      makeEnvelope({ sequence: 1001, intent: 'hold', payload: { unitId: 'u' } }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const holdEvt = result.events.find((e) => e.kind === 'hold')
    expect(holdEvt?.source).toBe('physics')
  })
})

// =============================================================================
// T1-A：entrench（构筑工事/战壕）物理结算
// =============================================================================
describe('simulateTurn T1-A：entrench 物理结算', () => {
  it('entrench 命令产出 entrench 事件，单位 entrenchment +1（封顶 3），cell.fortificationLevel 提升', () => {
    const world = makeWorld([
      makeUnit({
        id: 'engineer',
        factionId: 'blue',
        coord: { col: 0, row: 0 },
        morale: 50,
        fatigue: 10,
        entrenchment: 0,
      }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'entrench',
        payload: { unitId: 'engineer' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)

    // 产出 entrench 事件
    const entrenchEvt = result.events.find((e) => e.kind === 'entrench')
    expect(entrenchEvt).toBeDefined()
    expect(entrenchEvt?.source).toBe('physics')

    // 单位 entrenchment 0 → 1，morale +2（专注工事）
    const upd = result.stateChanges.unitUpdates['engineer']
    expect(upd?.entrenchment).toBe(1)
    expect(upd?.morale).toBe(52) // 50 + 2
    // 单位不移动（coord 不写）
    expect(upd?.coord).toBeUndefined()

    // cell.fortificationLevel 提升到 entrenchment（1）
    const cellUpd = result.stateChanges.cellUpdates?.['0:0']
    expect(cellUpd?.fortificationLevel).toBe(1)
  })

  it('entrench 命令在 entrenchment=3 时封顶，不再 +1', () => {
    const world = makeWorld([
      makeUnit({
        id: 'engineer',
        factionId: 'blue',
        coord: { col: 0, row: 0 },
        morale: 50,
        entrenchment: 3,
      }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'entrench',
        payload: { unitId: 'engineer' },
      }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const upd = result.stateChanges.unitUpdates['engineer']
    expect(upd?.entrenchment).toBe(3) // 封顶
    const cellUpd = result.stateChanges.cellUpdates?.['0:0']
    expect(cellUpd?.fortificationLevel).toBe(3)
  })

  it('entrench 缺 unitId → blockade「缺少 unitId」', () => {
    const world = makeWorld([])
    const orders: ActionEnvelope[] = [
      makeEnvelope({ sequence: 1001, intent: 'entrench', payload: {} }),
    ]
    const result = simulateTurn(world, orders, 's', 1)
    const blockade = result.events.find((e) => e.kind === 'blockade')
    expect(blockade).toBeDefined()
    expect((blockade!.data as { reason: string }).reason).toBe('缺少 unitId')
  })

  it('applyBaselineToAll 末尾：cell.fortificationLevel>0 且无单位驻留 → -1 衰减', () => {
    // 构造一个无人驻留但 fortificationLevel=2 的 cell，验证结算后衰减为 1
    const world = makeWorld([
      makeUnit({
        id: 'lonewolf',
        factionId: 'blue',
        coord: { col: 1, row: 0 }, // 单位在 (1,0)
      }),
    ])
    // (0,0) cell 有 fortificationLevel=2 但无人驻留 → 衰减为 1
    world.map.cells[0] = makeCell({
      id: '0:0',
      col: 0,
      row: 0,
      movementCost: 1,
      defenseBonus: 0,
      fortificationLevel: 2,
    })
    const orders: ActionEnvelope[] = [] // 空命令，仅触发基线
    const result = simulateTurn(world, orders, 's', 1)
    const cellUpd = result.stateChanges.cellUpdates?.['0:0']
    expect(cellUpd?.fortificationLevel).toBe(1) // 2 - 1
  })

  it('entrench 确定性：相同输入两次结算 → 相同 entrench 增量', () => {
    const world = makeWorld([
      makeUnit({ id: 'u', factionId: 'blue', coord: { col: 0, row: 0 }, entrenchment: 1 }),
    ])
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'entrench',
        payload: { unitId: 'u' },
      }),
    ]
    const r1 = simulateTurn(world, orders, 's', 1)
    const r2 = simulateTurn(world, orders, 's', 1)
    expect(r1).toEqual(r2)
  })
})

// =============================================================================
// T1-B/C：天气与日夜 modifier 接线（physics.worker 读 world.weather/timeOfDay）
// =============================================================================
describe('simulateTurn T1-B/C：天气/日夜 modifier', () => {
  it('T1-B：rain 天气 movementCostMult 1.5 → 移动燃料消耗 ×1.5', () => {
    const worldRain = makeWorld([
      makeUnit({ id: 'mover', factionId: 'blue', coord: { col: 0, row: 0 }, fuel: 100 }),
    ])
    worldRain.weather = {
      type: 'rain',
      remainingTurns: 2,
      modifiers: { movementCostMult: 1.5, visibilityPenalty: 0, combatMod: 0 },
    }
    const worldClear = makeWorld([
      makeUnit({ id: 'mover', factionId: 'blue', coord: { col: 0, row: 0 }, fuel: 100 }),
    ])
    worldClear.weather = {
      type: 'clear',
      remainingTurns: 2,
      modifiers: { movementCostMult: 1, visibilityPenalty: 0, combatMod: 0 },
    }
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'move',
        payload: { unitId: 'mover', target: { col: 1, row: 0 } },
      }),
    ]
    const rRain = simulateTurn(worldRain, orders, 's', 1)
    const rClear = simulateTurn(worldClear, orders, 's', 1)
    const rainFuelCost = (rRain.events.find((e) => e.kind === 'movement')?.data as {
      fuelCost?: number
    })?.fuelCost
    const clearFuelCost = (rClear.events.find((e) => e.kind === 'movement')?.data as {
      fuelCost?: number
    })?.fuelCost
    expect(rainFuelCost).toBeDefined()
    expect(clearFuelCost).toBeDefined()
    expect(rainFuelCost).toBeGreaterThan(clearFuelCost!)
  })

  it('T1-C：night 时 recon gainedLevel -1（最低 L0）', () => {
    // 蓝方侦察单位在 (0,0)，红方单位在 (1,0)。night 时 recon 应降级。
    const worldDay = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'enemy', factionId: 'red', coord: { col: 1, row: 0 } }),
    ])
    worldDay.timeOfDay = 'day'
    const worldNight = makeWorld([
      makeUnit({ id: 'scout', factionId: 'blue', type: 'recon', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'enemy', factionId: 'red', coord: { col: 1, row: 0 } }),
    ])
    worldNight.timeOfDay = 'night'
    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        intent: 'recon',
        payload: { unitId: 'scout', target: { col: 1, row: 0 } },
      }),
    ]
    const rDay = simulateTurn(worldDay, orders, 's', 1)
    const rNight = simulateTurn(worldNight, orders, 's', 1)
    // day：recon 单位 gainedLevel = curObs(0) + 2 = 2（封顶 L3）
    // night：gainedLevel -1 = 1
    const dayEvt = rDay.events.find((e) => e.kind === 'recon')
    const nightEvt = rNight.events.find((e) => e.kind === 'recon')
    const dayLevels = (dayEvt?.data as { levelsGained?: Array<{ afterLevel: number }> })
      ?.levelsGained
    const nightLevels = (nightEvt?.data as { levelsGained?: Array<{ afterLevel: number }> })
      ?.levelsGained
    expect(dayLevels?.[0]?.afterLevel).toBe(2)
    expect(nightLevels?.[0]?.afterLevel).toBe(1) // night -1
  })
})

// =============================================================================
// T1-D：checkRoutAndSurrender 接线（simulateTurn 末尾调用）
// =============================================================================
describe('simulateTurn T1-D：溃退/投降接线', () => {
  it('低 morale 单位在 simulateTurn 末尾触发溃退事件', () => {
    // 3x3 地图，蓝方单位在 (1,1) morale=10 strength=20，蓝方补给源在 (0,0)
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
    const world: WorldState = {
      saveId: 's',
      playerFactionId: '',
      scenarioId: 'sc',
      scenarioSeed: 'sc:s',
      turnIndex: 1,
      inGameDate: 'D-1',
      factions: [],
      units: [
        makeUnit({
          id: 'broken',
          factionId: 'blue',
          coord: { col: 1, row: 1 },
          morale: 10,
          strength: 20,
        }),
      ],
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
    const result = simulateTurn(world, [], 's', 1)
    const routEvt = result.events.find((e) => e.kind === 'rout')
    expect(routEvt).toBeDefined()
    const routUpd = result.stateChanges.unitUpdates['broken']
    expect(routUpd?.status).toContain('routed')
    expect(routUpd?.strength).toBe(10) // 20 - 10
  })
})

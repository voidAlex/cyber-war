/**
 * 补给线/后勤（supply.ts）单测 — 第 4 批。
 *
 * 验证：
 * - computeSupplyConnectivity：连通/切断/缺省兼容/多源冗余/单位不在线。
 * - applySupplyState：切断加 low_supply + morale -5；连通无变更。
 * - findSupplyCutOpportunities：可切断敌方补给的 cell。
 * - resolveSupplyMultiplier：连通=1.0，切断=默认 2.0 / rules 覆写。
 * - 确定性：相同输入 → 相同输出（纯函数）。
 *
 * @module __tests__/domain/supply
 */

import { describe, expect, it } from 'vitest'
import {
  computeSupplyConnectivity,
  applySupplyState,
  findSupplyCutOpportunities,
  resolveSupplyMultiplier,
  SEVERED_SUPPLY_MULTIPLIER,
} from '@/layers/domain/supply'
import type { WorldState, Unit, MapCell, GameMap, SupplyNetwork } from '@/types'

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

/** 构造含 supplyNetwork 的 GameMap（cellIds 用 "col:row" 形式，与单位坐标对齐）。 */
function makeMapWithNetwork(network: SupplyNetwork): GameMap {
  return {
    gridType: 'square',
    cols: 10,
    rows: 10,
    cells: [
      makeCell({ id: '0:0', col: 0, row: 0, isSupplySource: true }),
      makeCell({ id: '1:0', col: 1, row: 0 }),
      makeCell({ id: '2:0', col: 2, row: 0 }),
      makeCell({ id: '3:0', col: 3, row: 0 }),
    ],
    highValueNodes: [],
    supplyNetwork: network,
  }
}

function makeWorld(units: Unit[], map: GameMap): WorldState {
  return {
    saveId: 's',
    playerFactionId: '',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex: 1,
    inGameDate: 'D-1',
    factions: [],
    units,
    map,
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

describe('computeSupplyConnectivity', () => {
  it('缺省兼容：无 supplyNetwork 时所有单位恒连通', () => {
    const map: GameMap = {
      gridType: 'square',
      cols: 1,
      rows: 1,
      cells: [makeCell()],
      highValueNodes: [],
    }
    const units = [makeUnit({ id: 'a' }), makeUnit({ id: 'b', factionId: 'red' })]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    // 仅 blue 阵营单位（computeSupplyConnectivity 语义是"某阵营连通性"）
    expect(conn.get('a')?.connected).toBe(true)
    expect(conn.size).toBe(1)
  })

  it('连通：单位在线上且路径无敌方占据', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'l1',
          factionId: 'blue',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'],
        },
      ],
    })
    // 单位在 cell 2:0（线末端），source 在 0:0，路径 1:0 无敌方
    const units = [makeUnit({ id: 'a', factionId: 'blue', coord: { col: 2, row: 0 } })]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.get('a')?.connected).toBe(true)
    expect(conn.get('a')?.sources).toEqual(['0:0'])
    expect(conn.get('a')?.blockedAt).toBeUndefined()
  })

  it('切断：路径中间 cell 被敌方占据', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'l1',
          factionId: 'blue',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'],
        },
      ],
    })
    // 蓝方在 2:0，红方（敌方）占据 1:0 → 阻断蓝方补给
    const units = [
      makeUnit({ id: 'blue-1', factionId: 'blue', coord: { col: 2, row: 0 } }),
      makeUnit({ id: 'red-1', factionId: 'red', coord: { col: 1, row: 0 } }),
    ]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.get('blue-1')?.connected).toBe(false)
    expect(conn.get('blue-1')?.blockedAt).toBe('1:0')
    expect(conn.get('blue-1')?.sources).toEqual([])
  })

  it('切断：敌方占据 source 也阻断', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'l1',
          factionId: 'blue',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'],
        },
      ],
    })
    const units = [
      makeUnit({ id: 'blue-1', factionId: 'blue', coord: { col: 2, row: 0 } }),
      makeUnit({ id: 'red-1', factionId: 'red', coord: { col: 0, row: 0 } }),
    ]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.get('blue-1')?.connected).toBe(false)
  })

  it('单位不在线上：connected=false', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'l1',
          factionId: 'blue',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'],
        },
      ],
    })
    // 蓝方在 3:0（不在线上）
    const units = [makeUnit({ id: 'a', factionId: 'blue', coord: { col: 3, row: 0 } })]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.get('a')?.connected).toBe(false)
  })

  it('多源冗余：一条线阻断但另一条线连通 → connected=true', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'l1',
          factionId: 'blue',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'], // 1:0 被敌方占
        },
        {
          id: 'l2',
          factionId: 'blue',
          type: 'rail',
          cellIds: ['0:0', '3:0', '2:0'], // 3:0 无敌方
        },
      ],
    })
    // 蓝方在 2:0（两条线末端），source 都是 0:0
    const units = [
      makeUnit({ id: 'blue-1', factionId: 'blue', coord: { col: 2, row: 0 } }),
      makeUnit({ id: 'red-1', factionId: 'red', coord: { col: 1, row: 0 } }),
    ]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.get('blue-1')?.connected).toBe(true)
    expect(conn.get('blue-1')?.sources).toEqual(['0:0'])
  })

  it('确定性：相同输入 → 相同输出', () => {
    const map = makeMapWithNetwork({
      lines: [
        { id: 'l1', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0', '2:0'] },
      ],
    })
    const units = [makeUnit({ id: 'a', factionId: 'blue', coord: { col: 2, row: 0 } })]
    const r1 = computeSupplyConnectivity(map, units, 'blue')
    const r2 = computeSupplyConnectivity(map, units, 'blue')
    expect(r1).toEqual(r2)
  })

  it('兼容 cell-{col}-{row} 命名风格（凡尔登风格）', () => {
    const map: GameMap = {
      gridType: 'square',
      cols: 5,
      rows: 1,
      cells: [
        makeCell({ id: 'cell-0-0', col: 0, row: 0, isSupplySource: true }),
        makeCell({ id: 'cell-1-0', col: 1, row: 0 }),
        makeCell({ id: 'cell-2-0', col: 2, row: 0 }),
      ],
      highValueNodes: [],
      supplyNetwork: {
        lines: [
          {
            id: 'l1',
            factionId: 'blue',
            type: 'road',
            cellIds: ['cell-0-0', 'cell-1-0', 'cell-2-0'],
          },
        ],
      },
    }
    const units = [makeUnit({ id: 'a', factionId: 'blue', coord: { col: 2, row: 0 } })]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.get('a')?.connected).toBe(true)
    expect(conn.get('a')?.sources).toEqual(['cell-0-0'])
  })

  it('歼灭单位（strength<=0）不在结果中', () => {
    const map = makeMapWithNetwork({
      lines: [{ id: 'l1', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0'] }],
    })
    const units = [
      makeUnit({ id: 'alive', factionId: 'blue', coord: { col: 1, row: 0 } }),
      makeUnit({ id: 'dead', factionId: 'blue', coord: { col: 1, row: 0 }, strength: 0 }),
    ]
    const conn = computeSupplyConnectivity(map, units, 'blue')
    expect(conn.has('alive')).toBe(true)
    expect(conn.has('dead')).toBe(false)
  })
})

describe('applySupplyState', () => {
  it('切断：加 low_supply + morale -5', () => {
    const unit = makeUnit({ morale: 80, status: [] })
    const result = applySupplyState(unit, false)
    expect(result.status).toContain('low_supply')
    expect(result.morale).toBe(75)
  })

  it('切断时 morale 封底 0', () => {
    const unit = makeUnit({ morale: 3, status: [] })
    expect(applySupplyState(unit, false).morale).toBe(0)
  })

  it('已含 low_supply 不重复添加', () => {
    const unit = makeUnit({ status: ['low_supply'] })
    const result = applySupplyState(unit, false)
    expect(result.status?.filter((s) => s === 'low_supply').length).toBe(1)
  })

  it('连通：不主动改（空对象）', () => {
    const unit = makeUnit({ status: ['low_supply'] })
    const result = applySupplyState(unit, true)
    expect(result).toEqual({})
  })
})

describe('findSupplyCutOpportunities', () => {
  it('返回敌方补给线上可占领的 cell（排除 source 与敌方已驻守格）', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'enemy-line',
          factionId: 'red',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'],
        },
      ],
    })
    // 我方=blue，敌方=red。敌方线 source=0:0，中间 1:0 空，末端 2:0 有 red 驻守
    const units = [makeUnit({ id: 'red-1', factionId: 'red', coord: { col: 2, row: 0 } })]
    const cells = findSupplyCutOpportunities(map, units, 'blue')
    // 期望含 1:0（中间空格），不含 0:0（source）、不含 2:0（敌方驻守）
    expect(cells).toContain('1:0')
    expect(cells).not.toContain('0:0')
    expect(cells).not.toContain('2:0')
  })

  it('无 supplyNetwork 返回空', () => {
    const map: GameMap = {
      gridType: 'square',
      cols: 1,
      rows: 1,
      cells: [makeCell()],
      highValueNodes: [],
    }
    expect(findSupplyCutOpportunities(map, [], 'blue')).toEqual([])
  })

  it('去重：多线共用 cell 只返回一次', () => {
    const map = makeMapWithNetwork({
      lines: [
        { id: 'l1', factionId: 'red', type: 'road', cellIds: ['0:0', '1:0', '2:0'] },
        { id: 'l2', factionId: 'red', type: 'rail', cellIds: ['0:0', '1:0', '3:0'] },
      ],
    })
    const cells = findSupplyCutOpportunities(map, [], 'blue')
    const count1 = cells.filter((c) => c === '1:0').length
    expect(count1).toBe(1)
  })
})

describe('resolveSupplyMultiplier', () => {
  it('连通=1.0', () => {
    expect(resolveSupplyMultiplier(true)).toBe(1.0)
  })

  it('切断默认=2.0', () => {
    expect(resolveSupplyMultiplier(false)).toBe(SEVERED_SUPPLY_MULTIPLIER)
    expect(SEVERED_SUPPLY_MULTIPLIER).toBe(2.0)
  })

  it('rules.severedMultiplier 覆写默认', () => {
    expect(resolveSupplyMultiplier(false, { severedMultiplier: 3.5 })).toBe(3.5)
  })
})

describe('WorldState 类型引用（JSDoc 完整性）', () => {
  it('makeWorld 不抛错', () => {
    const map = makeMapWithNetwork({
      lines: [{ id: 'l1', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0'] }],
    })
    const world = makeWorld([makeUnit({ coord: { col: 1, row: 0 } })], map)
    expect(world.units.length).toBe(1)
  })
})

// =============================================================================
// 集成测试：simulateTurn 端到端验证"占领补给线 cell → 切断补给"（agent-browser 场景的核心逻辑）
// =============================================================================

import { simulateTurn } from '@/workers/physics.worker'
import type { ActionEnvelope } from '@/types'

function makeEnvelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    turn: 1,
    faction: 'red',
    agentId: 'red-theater-1',
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

describe('simulateTurn × supply 集成（占领补给线 → 切断补给）', () => {
  /**
   * 场景：法军单位在 cell 2:0（补给线末端），法军补给线 source=0:0。
   * 红方单位**初始已占据** cell 1:0（补给线中间格），本回合不移动。
   *
   * 时序说明：补给连通性在回合**开始**时判定（基于初始单位位置），
   * 与 worker applyBaselineToAll 一致。本回合移动占的 cell 在下回合才生效。
   * 这符合"占领需要时间"的直观，且保持确定性（基线消耗与命令结算用同一快照）。
   *
   * 期望（红方初始就在 1:0）：
   * - 产出 supply_cut 事件（蓝方上回合连通→本回合切断）。
   * - 蓝方单位 fuel/ammo 基线消耗 ×2（4 而非 2）。
   * - 蓝方单位 status 含 'low_supply'，morale -5。
   * - 红方阵营无线 → 视为缺省连通，**不被误判**为 low_supply。
   */
  it('敌方占据补给线中间 cell → 切断法军补给（加速消耗 + low_supply + supply_cut 事件）', () => {
    const map = makeMapWithNetwork({
      lines: [
        {
          id: 'fr-line',
          factionId: 'blue',
          type: 'road',
          cellIds: ['0:0', '1:0', '2:0'],
        },
      ],
    })
    // 蓝方单位在线末端 2:0（上回合连通，status 无 low_supply）
    const blueUnit = makeUnit({
      id: 'blue-1',
      factionId: 'blue',
      coord: { col: 2, row: 0 },
      fuel: 60,
      ammo: 60,
      morale: 70,
      status: [],
    })
    // 红方单位**初始就在** 1:0（切断蓝方补给）
    const redUnit = makeUnit({
      id: 'red-1',
      factionId: 'red',
      coord: { col: 1, row: 0 },
      fuel: 100,
      morale: 70,
    })
    const world = makeWorld([blueUnit, redUnit], map)

    // 本回合无命令（仅验证基线 + supply 切断）
    const result = simulateTurn(world, [], 'sc:s', 1)

    // 找 supply_cut 事件
    const supplyCut = result.events.find((e) => e.kind === 'supply_cut')
    expect(supplyCut).toBeDefined()
    expect(supplyCut?.data.unitId).toBe('blue-1')
    expect(supplyCut?.data.blockedAt).toBe('1:0')

    // 蓝方单位 fuel/ammo 基线消耗 ×2（4 而非 2）：60 - 4 = 56
    const blueUpdate = result.stateChanges.unitUpdates['blue-1']
    expect(blueUpdate?.fuel).toBe(56) // 60 - 4（SEVERED_SUPPLY_MULTIPLIER=2 × FUEL_BASELINE=2）
    expect(blueUpdate?.ammo).toBe(56)
    // status 含 low_supply
    expect(blueUpdate?.status).toContain('low_supply')
    // morale -5
    expect(blueUpdate?.morale).toBe(65)

    // 红方阵营无线 → 缺省连通，**不应**被标 low_supply（关键回归点）
    const redUpdate = result.stateChanges.unitUpdates['red-1']
    expect(redUpdate?.status ?? []).not.toContain('low_supply')
    // 红方基线消耗 ×1（连通）：100 - 2 = 98
    expect(redUpdate?.fuel).toBe(98)
  })

  it('补给线恢复（敌方撤离）→ supply_restored 事件 + 移除 low_supply', () => {
    const map = makeMapWithNetwork({
      lines: [
        { id: 'fr-line', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0', '2:0'] },
      ],
    })
    // 蓝方上回合已被切断（status 含 low_supply），本回合红方撤离 1:0
    const blueUnit = makeUnit({
      id: 'blue-1',
      factionId: 'blue',
      coord: { col: 2, row: 0 },
      fuel: 50,
      status: ['low_supply'],
    })
    const world = makeWorld([blueUnit], map) // 红方不在 1:0

    const result = simulateTurn(world, [], 'sc:s', 1)

    const restored = result.events.find((e) => e.kind === 'supply_restored')
    expect(restored).toBeDefined()
    expect(restored?.data.unitId).toBe('blue-1')
    // 恢复后基线消耗 ×1（2 而非 4）：50 - 2 = 48
    expect(result.stateChanges.unitUpdates['blue-1']?.fuel).toBe(48)
  })

  it('resupply 命令：补给被切断时拒绝（不 +25，push supply_blocked）', () => {
    const map = makeMapWithNetwork({
      lines: [
        { id: 'fr-line', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0', '2:0'] },
      ],
    })
    const blueUnit = makeUnit({
      id: 'blue-1',
      factionId: 'blue',
      coord: { col: 2, row: 0 },
      fuel: 30,
    })
    // 红方占据 1:0 切断蓝方补给
    const redUnit = makeUnit({ id: 'red-1', factionId: 'red', coord: { col: 1, row: 0 } })
    const world = makeWorld([blueUnit, redUnit], map)

    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'resupply',
        payload: { unitId: 'blue-1' },
      }),
    ]

    const result = simulateTurn(world, orders, 'sc:s', 1)

    // supply_blocked 事件
    const blocked = result.events.find((e) => e.kind === 'supply_blocked')
    expect(blocked).toBeDefined()
    expect(blocked?.data.unitId).toBe('blue-1')

    // 不应产出 resupply 事件（被拒）
    const resupplied = result.events.find((e) => e.kind === 'resupply')
    expect(resupplied).toBeUndefined()

    // resupply 命令不修改 fuel/ammo（仍受基线消耗影响：30 - 4 = 26）
    // 注意：resupply 命令被拒不写 fuel/ammo，但基线消耗仍应用
    expect(result.stateChanges.unitUpdates['blue-1']?.fuel).toBe(26)
  })

  it('resupply 命令：补给连通时正常 +25', () => {
    const map = makeMapWithNetwork({
      lines: [
        { id: 'fr-line', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0', '2:0'] },
      ],
    })
    const blueUnit = makeUnit({
      id: 'blue-1',
      factionId: 'blue',
      coord: { col: 2, row: 0 },
      fuel: 30,
    })
    // 无敌方占据 → 连通
    const world = makeWorld([blueUnit], map)

    const orders: ActionEnvelope[] = [
      makeEnvelope({
        sequence: 1001,
        faction: 'blue',
        intent: 'resupply',
        payload: { unitId: 'blue-1' },
      }),
    ]

    const result = simulateTurn(world, orders, 'sc:s', 1)

    const resupplied = result.events.find((e) => e.kind === 'resupply')
    expect(resupplied).toBeDefined()
    // resupply 写入 fuel=55（30+25），基线消耗合并时 existing.fuel 优先
    expect(result.stateChanges.unitUpdates['blue-1']?.fuel).toBe(55)
  })

  it('确定性：占领补给线场景两次结算 → 完全相同结果', () => {
    const map = makeMapWithNetwork({
      lines: [
        { id: 'fr-line', factionId: 'blue', type: 'road', cellIds: ['0:0', '1:0', '2:0'] },
      ],
    })
    const buildWorld = () =>
      makeWorld(
        [
          makeUnit({
            id: 'blue-1',
            factionId: 'blue',
            coord: { col: 2, row: 0 },
            fuel: 60,
            ammo: 60,
            status: [],
          }),
          makeUnit({ id: 'red-1', factionId: 'red', coord: { col: 1, row: 0 } }),
        ],
        map,
      )
    const r1 = simulateTurn(buildWorld(), [], 'sc:s', 1)
    const r2 = simulateTurn(buildWorld(), [], 'sc:s', 1)
    expect(r1).toEqual(r2)
  })
})

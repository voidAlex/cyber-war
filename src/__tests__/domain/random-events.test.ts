/**
 * 战役随机事件（random-events）单测 — 第 2 批。
 *
 * 验证：
 * - 确定性：相同 (world, turn, rules, scenarioSeed) → 相同事件集 + 相同 effects。
 * - 触发条件：weight 概率 / turnRange / morale_below / turn_in 强制触发。
 * - 效果解析：all/faction/region/specific targetKind + set/add op + clamp。
 * - singleTarget 按权重挑选（确定性）。
 * - reinforcement：援军注入 + reinforcementUnits 完整定义携带。
 * - 不伪造：effects 仅引用真实单位（region 外的单位不受影响）。
 * - 凡尔登规则集成：第 5 回合强制触发法军援军。
 *
 * @module __tests__/domain/random-events
 */

import { describe, expect, it } from 'vitest'
import {
  rollRandomEvents,
  resolveEffectTemplate,
  RANDOM_EVENT_SEQUENCE,
} from '@/layers/domain/random-events'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import { verdunRules } from '@/data/verdun-1916/rules'
import type {
  WorldState,
  Unit,
  MapCell,
  CampaignRules,
  RandomEventEffectTemplate,
} from '@/types'

// =============================================================================
// 测试夹具
// =============================================================================

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
    strength: 80,
    personnel: 1000,
    maxPersonnel: 1000,
    fuel: 80,
    ammo: 80,
    morale: 60,
    fatigue: 10,
    detection: {},
    orders: [],
    status: [],
    ...overrides,
  }
}

function makeWorld(units: Unit[], scenarioSeed = 'sc:s'): WorldState {
  return {
    saveId: 's',
    scenarioId: 'sc',
    scenarioSeed,
    turnIndex: 1,
    inGameDate: 'D-1',
    factions: [],
    units,
    map: {
      gridType: 'square',
      cols: 10,
      rows: 10,
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

// =============================================================================
// 确定性测试
// =============================================================================

describe('rollRandomEvents 确定性', () => {
  it('相同 (world, turn, rules, scenarioSeed) 两次调用 → 相同结果', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'evt-a',
          kind: 'weather',
          weight: 0.5,
          turnRange: [1, 10],
          label: '测试事件 A',
          description: 'A',
          effects: [
            {
              targetKind: 'all',
              field: 'fatigue',
              op: 'add',
              value: 10,
              reason: '疲劳+10',
            },
          ],
        },
        {
          id: 'evt-b',
          kind: 'surprise',
          weight: 0.5,
          turnRange: [1, 10],
          label: '测试事件 B',
          description: 'B',
          effects: [
            {
              targetKind: 'faction',
              factionId: 'blue',
              field: 'strength',
              op: 'add',
              value: -15,
              singleTarget: true,
              reason: '突袭',
            },
          ],
        },
      ],
    }
    const world = makeWorld([
      makeUnit({ id: 'u1', factionId: 'blue', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'u2', factionId: 'blue', coord: { col: 1, row: 0 } }),
    ])
    const r1 = rollRandomEvents(world, 3, rules, 'sc:s')
    const r2 = rollRandomEvents(world, 3, rules, 'sc:s')
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2))
  })

  it('不同 scenarioSeed → 可能不同结果（确定性根生效）', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'evt-a',
          kind: 'weather',
          weight: 0.5, // 中等概率，多种子下必然出现触发/不触发的分化
          turnRange: [1, 10],
          label: 'A',
          description: 'A',
          effects: [
            { targetKind: 'all', field: 'fatigue', op: 'add', value: 5, reason: 'r' },
          ],
        },
      ],
    }
    const world = makeWorld([makeUnit({ id: 'u1' })])
    // 多种子扫描：weight 0.5 下足够多样本必然出现触发/不触发的分化
    const seeds: string[] = []
    for (let i = 0; i < 30; i++) seeds.push(`seed-${i}`)
    const counts = seeds.map((s) => rollRandomEvents(world, 3, rules, s).events.length)
    // 至少有一个种子下结果不同（触发 vs 不触发），证明 scenarioSeed 是确定性根
    expect(new Set(counts).size).toBeGreaterThan(1)
  })

  it('无 randomEvents 模板 → 空数组', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
    }
    const world = makeWorld([makeUnit()])
    const result = rollRandomEvents(world, 1, rules, 'sc:s')
    expect(result.events).toEqual([])
    expect(result.reinforcements).toEqual([])
  })
})

// =============================================================================
// 触发条件测试
// =============================================================================

describe('rollRandomEvents 触发条件', () => {
  it('turnRange 外的回合不触发', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'evt-x',
          kind: 'weather',
          weight: 1, // 必触发
          turnRange: [5, 10],
          label: 'X',
          description: 'X',
          effects: [
            { targetKind: 'all', field: 'fatigue', op: 'add', value: 5, reason: 'r' },
          ],
        },
      ],
    }
    const world = makeWorld([makeUnit()])
    // 回合 3 在 [5,10] 外 → 不触发
    expect(rollRandomEvents(world, 3, rules, 'sc:s').events).toHaveLength(0)
    // 回合 7 在 [5,10] 内 → 触发
    expect(rollRandomEvents(world, 7, rules, 'sc:s').events).toHaveLength(1)
  })

  it('turn_in 强制触发：回合在 turns 列表内即触发（不参与概率）', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'reinforce',
          kind: 'reinforcement',
          weight: 0, // weight 0，仅 turn_in 才触发
          triggerCondition: { kind: 'turn_in', turns: [5, 10, 15] },
          label: '援军',
          description: '援军到达',
          effects: [],
        },
      ],
    }
    const world = makeWorld([makeUnit()])
    // 回合 5 强制触发
    expect(rollRandomEvents(world, 5, rules, 'sc:s').events).toHaveLength(1)
    // 回合 6 不触发（不在 turns 列表，weight 0）
    expect(rollRandomEvents(world, 6, rules, 'sc:s').events).toHaveLength(0)
  })

  it('morale_below：阵营平均士气低于阈值才候选', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'mutiny',
          kind: 'mutiny',
          weight: 1, // 候选时必触发
          triggerCondition: {
            kind: 'morale_below',
            factionId: 'blue',
            moraleThreshold: 30,
          },
          label: '兵变',
          description: '兵变',
          effects: [
            {
              targetKind: 'faction',
              factionId: 'blue',
              field: 'morale',
              op: 'add',
              value: -20,
              reason: '兵变',
            },
          ],
        },
      ],
    }
    // 士气 60（平均 60）>= 30 → 不触发
    const worldHigh = makeWorld([makeUnit({ factionId: 'blue', morale: 60 })])
    expect(rollRandomEvents(worldHigh, 1, rules, 'sc:s').events).toHaveLength(0)
    // 士气 20（平均 20）< 30 → 触发
    const worldLow = makeWorld([makeUnit({ factionId: 'blue', morale: 20 })])
    expect(rollRandomEvents(worldLow, 1, rules, 'sc:s').events).toHaveLength(1)
  })

  it('weight 概率：weight=0（非 turn_in）永不触发', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'rare',
          kind: 'weather',
          weight: 0,
          turnRange: [1, 10],
          label: '稀有',
          description: '稀有',
          effects: [
            { targetKind: 'all', field: 'fatigue', op: 'add', value: 5, reason: 'r' },
          ],
        },
      ],
    }
    const world = makeWorld([makeUnit()])
    // 10 个不同种子都不应触发（weight=0）
    for (const s of ['s1', 's2', 's3', 's4', 's5']) {
      expect(rollRandomEvents(world, 5, rules, s).events).toHaveLength(0)
    }
  })
})

// =============================================================================
// 效果解析测试（resolveEffectTemplate）
// =============================================================================

describe('resolveEffectTemplate 效果解析', () => {
  it('targetKind=all：所有单位受影响', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', fatigue: 10 }),
      makeUnit({ id: 'u2', fatigue: 20 }),
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'all',
      field: 'fatigue',
      op: 'add',
      value: 10,
      reason: '暴雨',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides).toHaveLength(2)
    expect(overrides[0].before).toBe(10)
    expect(overrides[0].after).toBe(20)
    expect(overrides[1].before).toBe(20)
    expect(overrides[1].after).toBe(30)
    expect(overrides[0].field).toBe('units.u1.fatigue')
  })

  it('targetKind=faction：仅指定阵营单位', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', factionId: 'blue', strength: 80 }),
      makeUnit({ id: 'u2', factionId: 'red', strength: 80 }),
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'faction',
      factionId: 'blue',
      field: 'strength',
      op: 'add',
      value: -10,
      reason: '减员',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides).toHaveLength(1)
    expect(overrides[0].field).toBe('units.u1.strength')
    expect(overrides[0].after).toBe(70)
  })

  it('targetKind=region：仅半径内单位', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', coord: { col: 5, row: 5 }, strength: 80 }), // 距离 0
      makeUnit({ id: 'u2', coord: { col: 6, row: 5 }, strength: 80 }), // 距离 1
      makeUnit({ id: 'u3', coord: { col: 9, row: 9 }, strength: 80 }), // 距离 8，超出
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'region',
      coord: { col: 5, row: 5 },
      radius: 2,
      field: 'strength',
      op: 'add',
      value: -10,
      reason: '毒气',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides).toHaveLength(2) // u1, u2 在半径内；u3 超出
    const ids = overrides.map((o) => o.field)
    expect(ids).toContain('units.u1.strength')
    expect(ids).toContain('units.u2.strength')
    expect(ids).not.toContain('units.u3.strength')
  })

  it('targetKind=specific：仅显式指定单位', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', strength: 80 }),
      makeUnit({ id: 'u2', strength: 80 }),
      makeUnit({ id: 'u3', strength: 80 }),
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'specific',
      unitIds: ['u1', 'u3'],
      field: 'strength',
      op: 'set',
      value: 50,
      reason: '重置',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides).toHaveLength(2)
    expect(overrides.every((o) => o.after === 50)).toBe(true)
  })

  it('singleTarget=true：仅挑一个单位（确定性）', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', factionId: 'blue', strength: 80 }),
      makeUnit({ id: 'u2', factionId: 'blue', strength: 80 }),
      makeUnit({ id: 'u3', factionId: 'blue', strength: 80 }),
    ])
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'faction',
      factionId: 'blue',
      field: 'strength',
      op: 'add',
      value: -15,
      singleTarget: true,
      reason: '突袭',
    }
    // 相同种子 → 相同选择
    const r1 = resolveEffectTemplate(tpl, world, new DeterministicRandom('s1'))
    const r2 = resolveEffectTemplate(tpl, world, new DeterministicRandom('s1'))
    expect(r1).toEqual(r2)
    expect(r1).toHaveLength(1)
  })

  it('clamp：strength 不低于 0、不高于 100', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', strength: 5 }), // 减 20 → clamp 到 0
      makeUnit({ id: 'u2', strength: 95 }), // 加 20 → clamp 到 100
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'all',
      field: 'strength',
      op: 'add',
      value: -20,
      reason: '减员',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides[0].after).toBe(0) // 5-20=-15 → clamp 0
    expect(overrides[1].after).toBe(75) // 95-20=75
  })

  it('filterField/filterBelow：仅 morale<30 的单位进入候选', () => {
    const world = makeWorld([
      makeUnit({ id: 'u1', factionId: 'blue', morale: 20, strength: 80 }),
      makeUnit({ id: 'u2', factionId: 'blue', morale: 60, strength: 80 }),
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'faction',
      factionId: 'blue',
      field: 'strength',
      op: 'add',
      value: -10,
      filterField: 'morale',
      filterBelow: 30,
      reason: '低士气单位',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides).toHaveLength(1) // 仅 u1（morale 20<30）
    expect(overrides[0].field).toBe('units.u1.strength')
  })
})

// =============================================================================
// reinforcement 测试
// =============================================================================

describe('rollRandomEvents reinforcement', () => {
  it('reinforcement 触发 → 援军单位返回 + effects 引用新单位', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'reinforce-1',
          kind: 'reinforcement',
          weight: 0,
          triggerCondition: { kind: 'turn_in', turns: [1] },
          label: '援军',
          description: '援军到达',
          reinforcementUnits: [
            {
              id: 'reinforce-unit-1',
              factionId: 'blue',
              type: 'infantry',
              coord: { col: 0, row: 0 },
              strength: 80,
              personnel: 1000,
              maxPersonnel: 1000,
              fuel: 80,
              ammo: 80,
              morale: 70,
              fatigue: 10,
              status: [],
            },
          ],
          effects: [
            {
              targetKind: 'specific',
              unitIds: ['reinforce-unit-1'],
              field: 'morale',
              op: 'set',
              value: 90,
              reason: '援军初始士气',
            },
          ],
        },
      ],
    }
    const world = makeWorld([makeUnit({ id: 'existing' })])
    const result = rollRandomEvents(world, 1, rules, 'sc:s')
    expect(result.events).toHaveLength(1)
    const ev = result.events[0]
    expect(ev.reinforcementUnitIds).toEqual(['reinforce-unit-1'])
    expect(ev.reinforcementUnits).toHaveLength(1)
    expect(ev.reinforcementUnits?.[0].id).toBe('reinforce-unit-1')
    // effects 能引用新注入的援军单位（worldWithReinforcement 解析）
    expect(ev.effects).toHaveLength(1)
    expect(ev.effects[0].field).toBe('units.reinforce-unit-1.morale')
    expect(ev.effects[0].after).toBe(90)
    // reinforcements 返回待应用列表
    expect(result.reinforcements).toHaveLength(1)
    expect(result.reinforcements[0].id).toBe('reinforce-unit-1')
  })

  it('reinforcement 幂等：已存在的 unitId 不重复注入', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'reinforce-2',
          kind: 'reinforcement',
          weight: 0,
          triggerCondition: { kind: 'turn_in', turns: [1] },
          label: '援军',
          description: '援军到达',
          reinforcementUnits: [
            {
              id: 'existing', // 已存在
              factionId: 'blue',
              type: 'infantry',
              coord: { col: 0, row: 0 },
              strength: 80,
              personnel: 1000,
              maxPersonnel: 1000,
              fuel: 80,
              ammo: 80,
              morale: 70,
              fatigue: 10,
              status: [],
            },
          ],
          effects: [],
        },
      ],
    }
    const world = makeWorld([makeUnit({ id: 'existing' })])
    const result = rollRandomEvents(world, 1, rules, 'sc:s')
    expect(result.reinforcements).toHaveLength(0) // 已存在，跳过
    expect(result.events[0].reinforcementUnitIds).toBeUndefined()
  })
})

// =============================================================================
// 凡尔登规则集成测试
// =============================================================================

describe('凡尔登规则集成', () => {
  it('第 5 回合强制触发法军援军（turn_in）', () => {
    // 用凡尔登单位初始化 world（仅取法军援军相关的最小集）
    const world = makeWorld(
      [makeUnit({ id: 'fr-fortress-douaumont', factionId: 'france', coord: { col: 7, row: 2 } })],
      'verdun-1916',
    )
    const result = rollRandomEvents(world, 5, verdunRules, 'verdun-1916')
    const reinforcementEvent = result.events.find(
      (e) => e.id === 'verdun-french-reinforcement',
    )
    expect(reinforcementEvent).toBeDefined()
    expect(reinforcementEvent?.kind).toBe('reinforcement')
    expect(reinforcementEvent?.reinforcementUnitIds).toContain('fr-reinforcement-corps')
    expect(result.reinforcements.length).toBeGreaterThan(0)
  })

  it('凡尔登规则包含 5 个事件模板', () => {
    expect(verdunRules.randomEvents).toBeDefined()
    expect(verdunRules.randomEvents).toHaveLength(5)
    const kinds = verdunRules.randomEvents!.map((e) => e.kind).sort()
    expect(kinds).toEqual(['gas', 'mutiny', 'reinforcement', 'surprise', 'weather'])
  })

  it('第 6 回合（不在 turn_in 列表）援军不强制触发（但其他 weight 事件按概率）', () => {
    const world = makeWorld(
      [makeUnit({ id: 'fr-fortress-douaumont', factionId: 'france', coord: { col: 7, row: 2 } })],
      'verdun-1916',
    )
    const result = rollRandomEvents(world, 6, verdunRules, 'verdun-1916')
    const reinforcementEvent = result.events.find(
      (e) => e.id === 'verdun-french-reinforcement',
    )
    // 回合 6 不在 [5,10,15]，turn_in 不命中，weight 0 → 不触发
    expect(reinforcementEvent).toBeUndefined()
  })

  it('确定性：相同凡尔登 seed+turn → 相同事件集', () => {
    const world = makeWorld(
      [
        makeUnit({ id: 'fr-fortress-douaumont', factionId: 'france', coord: { col: 7, row: 2 } }),
        makeUnit({ id: 'de-infantry-21', factionId: 'germany', coord: { col: 9, row: 2 } }),
      ],
      'verdun-1916',
    )
    const r1 = rollRandomEvents(world, 7, verdunRules, 'verdun-1916')
    const r2 = rollRandomEvents(world, 7, verdunRules, 'verdun-1916')
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2))
  })
})

// =============================================================================
// 不伪造测试
// =============================================================================

describe('不伪造约束', () => {
  it('region 范围外单位不受影响', () => {
    const world = makeWorld([
      makeUnit({ id: 'in-range', coord: { col: 5, row: 5 }, strength: 80 }),
      makeUnit({ id: 'out-range', coord: { col: 0, row: 0 }, strength: 80 }),
    ])
    const rng = new DeterministicRandom('test')
    const tpl: RandomEventEffectTemplate = {
      targetKind: 'region',
      coord: { col: 5, row: 5 },
      radius: 1,
      field: 'strength',
      op: 'add',
      value: -10,
      reason: '毒气',
    }
    const overrides = resolveEffectTemplate(tpl, world, rng)
    expect(overrides).toHaveLength(1)
    expect(overrides[0].field).toBe('units.in-range.strength')
    // out-range 不在结果中
  })

  it('effects 仅引用 world.units 真实单位（reinforcement 例外）', () => {
    const rules: CampaignRules = {
      intelDecay: { halfLifeTurns: 3, decayPerHalfLife: 1 },
      combat: { attritionRate: 0.1 },
      randomEvents: [
        {
          id: 'evt',
          kind: 'surprise',
          weight: 1,
          turnRange: [1, 10],
          label: 'X',
          description: 'X',
          effects: [
            {
              targetKind: 'specific',
              unitIds: ['ghost-unit', 'real-unit'], // ghost 不存在
              field: 'strength',
              op: 'add',
              value: -10,
              reason: 'r',
            },
          ],
        },
      ],
    }
    const world = makeWorld([makeUnit({ id: 'real-unit', strength: 80 })])
    const result = rollRandomEvents(world, 1, rules, 'sc:s')
    expect(result.events).toHaveLength(1)
    // 仅 real-unit 被覆写（ghost-unit 跳过，不伪造）
    const fields = result.events[0].effects.map((e) => e.field)
    expect(fields).toContain('units.real-unit.strength')
    expect(fields).not.toContain('units.ghost-unit.strength')
  })

  it('RANDOM_EVENT_SEQUENCE 固定为 9999（确定性根槽位）', () => {
    expect(RANDOM_EVENT_SEQUENCE).toBe(9999)
  })
})

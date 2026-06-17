/**
 * 回放 random_event 采信测试（replay-random-event.test.ts）— 验收#7 红线（第 2 批）。
 *
 * 验证「random_event 在回放采信 log，不重算」：
 * 1. 构造 random_event AgentAction（source:'director'，含 effects + reinforcementUnits）。
 * 2. restoreFromEventLog：effects 应用到 world.units；reinforcementUnits 注入 world.units。
 * 3. 二次回放一致性（采信 log，相同输入 → 相同输出）。
 *
 * @module __tests__/replay-random-event
 */

import { describe, it, expect } from 'vitest'
import { restoreFromEventLog } from '@/layers/persistence/replay'
import type { WorldState, Unit, AgentAction } from '@/types'

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

function makeBaseWorld(units: Unit[]): WorldState {
  return {
    saveId: 's',
    playerFactionId: 'blue',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex: 0,
    inGameDate: 'D-0',
    factions: [
      {
        id: 'blue',
        name: '蓝',
        color: '#00F',
        side: 'player',
        commander: {
          id: 'c1',
          name: 'c',
          personality: '',
          aggression: 0.5,
          obedience: 0.5,
          preferredTempo: 'balanced',
          doctrineTags: [],
        },
        theaterCommanders: [],
        supply: { supplies: 0, ammunition: 0, fuel: 0 },
        trust: {},
        doctrineTags: [],
      },
    ],
    units,
    map: { gridType: 'square', cols: 5, rows: 5, cells: [], highValueNodes: [] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

describe('restoreFromEventLog — 第 2 批 random_event 采信', () => {
  it('random_event effects 应用到 world.units（采信 log 的 after 值）', () => {
    const baseWorld = makeBaseWorld([makeUnit({ id: 'u1', fatigue: 10 })])
    const events: AgentAction[] = [
      {
        id: 'evt:4001:random-event:evt-rain',
        turn: 0,
        agentId: 'director-random-events',
        agentRole: 'director',
        kind: 'adjudication',
        source: 'director',
        payload: {
          kind: 'random_event',
          description: '暴雨降低机动',
          data: {
            eventId: 'evt-rain',
            eventKind: 'weather',
            label: '暴雨',
            effects: [
              {
                field: 'units.u1.fatigue',
                before: 10,
                after: 25,
                reason: '暴雨泥泞',
              },
            ],
            reinforcementUnitIds: [],
            reinforcementUnits: [],
          },
        },
        text: '[随机事件] 暴雨',
        sequence: 4001,
        seed: 'sc:s:0:4001',
      },
    ]
    const result = restoreFromEventLog(events, baseWorld, 'sc:s')
    const unit = result.world.units.find((u) => u.id === 'u1')
    expect(unit?.fatigue).toBe(25) // 采信 log after 值
  })

  it('random_event reinforcementUnits 注入 world.units（采信 log，回放重建）', () => {
    const baseWorld = makeBaseWorld([makeUnit({ id: 'existing' })])
    const events: AgentAction[] = [
      {
        id: 'evt:4001:random-event:evt-reinforce',
        turn: 0,
        agentId: 'director-random-events',
        agentRole: 'director',
        kind: 'adjudication',
        source: 'director',
        payload: {
          kind: 'random_event',
          description: '援军到达',
          data: {
            eventId: 'evt-reinforce',
            eventKind: 'reinforcement',
            label: '援军',
            effects: [],
            reinforcementUnitIds: ['reinforce-1'],
            reinforcementUnits: [
              {
                id: 'reinforce-1',
                factionId: 'blue',
                type: 'infantry',
                coord: { col: 2, row: 2 },
                strength: 85,
                personnel: 2000,
                maxPersonnel: 2000,
                fuel: 90,
                ammo: 90,
                morale: 75,
                fatigue: 5,
                status: [],
              },
            ],
          },
        },
        text: '[随机事件] 援军',
        sequence: 4001,
        seed: 'sc:s:0:4001',
      },
    ]
    const result = restoreFromEventLog(events, baseWorld, 'sc:s')
    const reinforcement = result.world.units.find((u) => u.id === 'reinforce-1')
    expect(reinforcement).toBeDefined()
    expect(reinforcement?.factionId).toBe('blue')
    expect(reinforcement?.strength).toBe(85)
    expect(reinforcement?.coord).toEqual({ col: 2, row: 2 })
    // 原有单位保留
    expect(result.world.units.find((u) => u.id === 'existing')).toBeDefined()
  })

  it('二次回放一致性：相同 events + baseWorld → 相同结果', () => {
    const baseWorld = makeBaseWorld([makeUnit({ id: 'u1', strength: 80 })])
    const events: AgentAction[] = [
      {
        id: 'evt:4001:random-event:evt-strike',
        turn: 0,
        agentId: 'director-random-events',
        agentRole: 'director',
        kind: 'adjudication',
        source: 'director',
        payload: {
          kind: 'random_event',
          description: '炮击',
          data: {
            eventId: 'evt-strike',
            eventKind: 'surprise',
            label: '炮击',
            effects: [
              {
                field: 'units.u1.strength',
                before: 80,
                after: 65,
                reason: '炮击',
              },
            ],
            reinforcementUnitIds: [],
            reinforcementUnits: [],
          },
        },
        text: '[随机事件] 炮击',
        sequence: 4001,
        seed: 'sc:s:0:4001',
      },
    ]
    const r1 = restoreFromEventLog(events, baseWorld, 'sc:s')
    const r2 = restoreFromEventLog(events, baseWorld, 'sc:s')
    expect(r1.world.units.find((u) => u.id === 'u1')?.strength).toBe(65)
    expect(r2.world.units.find((u) => u.id === 'u1')?.strength).toBe(65)
    // 完全一致（deep equality）
    expect(JSON.stringify(r1.world.units)).toEqual(JSON.stringify(r2.world.units))
  })

  it('random_event 与 director override 共存：override 在 random_event 之前/之后都能正确应用', () => {
    const baseWorld = makeBaseWorld([makeUnit({ id: 'u1', strength: 80 })])
    const events: AgentAction[] = [
      // director override
      {
        id: 'evt:3000:director-override:0',
        turn: 0,
        agentId: 'director-llm',
        agentRole: 'director',
        kind: 'adjudication',
        source: 'director',
        payload: {
          kind: 'override',
          field: 'units.u1.morale',
          before: 60,
          after: 50,
          reason: 'LLM 覆写',
        },
        sequence: 3000,
        seed: 'sc:s:0:3000',
      },
      // random_event
      {
        id: 'evt:4001:random-event:evt-gas',
        turn: 0,
        agentId: 'director-random-events',
        agentRole: 'director',
        kind: 'adjudication',
        source: 'director',
        payload: {
          kind: 'random_event',
          description: '毒气',
          data: {
            eventId: 'evt-gas',
            eventKind: 'gas',
            label: '毒气',
            effects: [
              {
                field: 'units.u1.strength',
                before: 80,
                after: 70,
                reason: '毒气',
              },
            ],
            reinforcementUnitIds: [],
            reinforcementUnits: [],
          },
        },
        text: '[随机事件] 毒气',
        sequence: 4001,
        seed: 'sc:s:0:4001',
      },
    ]
    const result = restoreFromEventLog(events, baseWorld, 'sc:s')
    const unit = result.world.units.find((u) => u.id === 'u1')
    expect(unit?.strength).toBe(70) // random_event effects
    expect(unit?.morale).toBe(50) // director override
  })
})

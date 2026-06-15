/**
 * 导演部 mock 终裁测试（director.test.ts）。
 *
 * 验证 M2 mock 导演部行为：
 * - adjudicate 透传物理结果（不覆写数值）。
 * - 战报摘要从 events 汇总战损/占领变更。
 * - directorEvents 标 source:'physics'（确定性两层）。
 *
 * 直接调 directorRole.adjudicate（mock 实现，无 LLM）。
 *
 * @module __tests__/agents/director
 */

import { describe, it, expect } from 'vitest'
import { directorRole } from '@/layers/agents/roles/director'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import type { WorldState, Unit } from '@/types'

/** 构造测试用物理结算结果 */
function makePhysicsResult(events: ResolutionEvent[]): ResolutionResult {
  return {
    turn: 0,
    events,
    stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] },
    success: true,
  }
}

/** 构造含单位的测试世界 */
function makeWorld(units: Unit[]): WorldState {
  return {
    saveId: 's',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex: 0,
    inGameDate: 'D-0',
    factions: [
      { id: 'blue', name: '蓝', color: '#00F', side: 'player', commander: { id: 'c1', name: 'c', personality: '', aggression: 0.5, obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 0, ammunition: 0, fuel: 0 }, trust: {}, doctrineTags: [] },
      { id: 'red', name: '红', color: '#F00', side: 'enemy', commander: { id: 'c2', name: 'c', personality: '', aggression: 0.5, obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 0, ammunition: 0, fuel: 0 }, trust: {}, doctrineTags: [] },
    ],
    units,
    map: { gridType: 'square', cols: 0, rows: 0, cells: [], highValueNodes: [] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

describe('directorRole.adjudicate — M2 mock 透传物理结果', () => {
  it('空事件：finalResult=physicsResult，战报显示「无战事」', async () => {
    const world = makeWorld([])
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    expect(result.finalResult.events).toEqual([])
    expect(result.resolutionSummary.degraded).toBe(false)
    expect(result.resolutionSummary.reportText).toContain('无战事')
    expect(result.directorEvents).toHaveLength(0)
  })

  it('交战事件：战损按攻防双方 faction 汇总', async () => {
    const units: Unit[] = [
      { id: 'attacker', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
      { id: 'defender', factionId: 'red', type: 'infantry', coord: { col: 1, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
    ]
    const evt: ResolutionEvent = {
      id: 'evt:1001:engagement:0',
      source: 'physics',
      turn: 0,
      sequence: 1001,
      kind: 'engagement',
      description: 'attacker 交火 defender',
      data: {
        attackerId: 'attacker',
        defenderId: 'defender',
        attackerLoss: 10,
        defenderLoss: 20,
        attackerPersonnelLoss: 100,
        defenderPersonnelLoss: 200,
      },
    }
    const world = makeWorld(units)
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([evt]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    expect(result.finalResult.events).toHaveLength(1)
    // 战损：蓝（攻方）+10/100，红（守方）+20/200
    expect(result.resolutionSummary.casualties['blue']).toEqual({ personnel: 100, strength: 10 })
    expect(result.resolutionSummary.casualties['red']).toEqual({ personnel: 200, strength: 20 })
  })

  it('directorEvents 标 source:physics（确定性两层留痕）', async () => {
    const evt: ResolutionEvent = {
      id: 'evt:0:movement:0',
      source: 'physics',
      turn: 0,
      sequence: 0,
      kind: 'movement',
      description: 'u1 机动至 (1,1)',
      data: { unitId: 'u1' },
    }
    const world = makeWorld([])
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([evt]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    expect(result.directorEvents).toHaveLength(1)
    expect(result.directorEvents[0].source).toBe('physics')
    expect(result.directorEvents[0].sequence).toBe(0)
    expect(result.directorEvents[0].seed).toBe('sc:s:0:0')
  })

  it('物理结果失败时战报标记 degraded', async () => {
    const failedResult: ResolutionResult = {
      turn: 0,
      events: [],
      stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] },
      success: false,
      error: 'sim failed',
    }
    const world = makeWorld([])
    const result = await directorRole.adjudicate({
      physicsResult: failedResult,
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    expect(result.resolutionSummary.degraded).toBe(true)
  })
})

// ============================================================================
// 第 2 批：随机事件接线（mock 路径应用 effects + 产 random_event AgentAction）
// ============================================================================

describe('directorRole.adjudicate — 第 2 批 随机事件接线', () => {
  it('randomEvents 传入 → effects 应用到 finalResult.stateChanges', async () => {
    const units: Unit[] = [
      { id: 'u1', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 }, strength: 80, personnel: 1000, maxPersonnel: 1000, fuel: 80, ammo: 80, morale: 60, fatigue: 10, detection: {}, orders: [], status: [] },
    ]
    const world = makeWorld(units)
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
      randomEvents: [
        {
          id: 'evt-rain',
          kind: 'weather',
          turn: 0,
          label: '暴雨',
          description: '暴雨降低机动',
          effects: [
            {
              field: 'units.u1.fatigue',
              before: 10,
              after: 20,
              reason: '暴雨泥泞',
            },
          ],
        },
      ],
    })
    // effects 应用到 stateChanges.unitUpdates
    expect(result.finalResult.stateChanges.unitUpdates['u1']?.fatigue).toBe(20)
  })

  it('randomEvents 传入 → 产 random_event AgentAction（source:director）', async () => {
    const world = makeWorld([])
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
      randomEvents: [
        {
          id: 'evt-gas',
          kind: 'gas',
          turn: 0,
          label: '毒气',
          description: '毒气攻击',
          effects: [],
        },
      ],
    })
    const randomEventAction = result.directorEvents.find(
      (e) => e.payload['kind'] === 'random_event',
    )
    expect(randomEventAction).toBeDefined()
    expect(randomEventAction?.source).toBe('director')
    expect(randomEventAction?.sequence).toBe(4001) // SEQUENCE_DIRECTOR_RANDOM_EVENT_BASE
    const data = randomEventAction?.payload['data'] as Record<string, unknown>
    expect(data['eventId']).toBe('evt-gas')
    expect(data['label']).toBe('毒气')
  })

  it('无 randomEvents → 不产 random_event AgentAction（兼容默认行为）', async () => {
    const world = makeWorld([])
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    const randomEventAction = result.directorEvents.find(
      (e) => e.payload['kind'] === 'random_event',
    )
    expect(randomEventAction).toBeUndefined()
  })

  it('reinforcement 随机事件：reinforcementUnits 写入 random_event payload（供回放重建）', async () => {
    const world = makeWorld([])
    const result = await directorRole.adjudicate({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
      randomEvents: [
        {
          id: 'evt-reinforce',
          kind: 'reinforcement',
          turn: 0,
          label: '援军',
          description: '援军到达',
          effects: [],
          reinforcementUnitIds: ['reinforce-1'],
          reinforcementUnits: [
            {
              id: 'reinforce-1',
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
        },
      ],
    })
    const randomEventAction = result.directorEvents.find(
      (e) => e.payload['kind'] === 'random_event',
    )
    const data = randomEventAction?.payload['data'] as Record<string, unknown>
    expect(data['reinforcementUnitIds']).toEqual(['reinforce-1'])
    const reinforcementUnits = data['reinforcementUnits'] as Array<Record<string, unknown>>
    expect(reinforcementUnits).toHaveLength(1)
    expect(reinforcementUnits[0]['id']).toBe('reinforce-1')
  })
})

/**
 * 规则引擎兜底测试（rule-engine-fallback.test.ts）。
 *
 * 验证（对应重写计划关键防坑「解析失败伪造 unit-1/C3」+ 修订点 E 离线降级）：
 * - LLM 失败/degraded 时采用物理 rawResults + 模板战报（`[规则引擎] 第N回合`）。
 * - 事件标 source:'rule-engine'（区别于 physics/director）。
 * - **绝不伪造**不存在的 unit/坐标/节点：兜底仅引用 physicsResult 真实事件数据。
 * - degraded=true（明示降级结算）。
 *
 * @module __tests__/agents/rule-engine-fallback
 */

import { describe, it, expect } from 'vitest'
import { ruleEngineFallback } from '@/layers/agents/director/rule-engine-fallback'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import type { WorldState, Unit } from '@/types'

/** 构造物理结算结果 */
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
    playerFactionId: 'blue',
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

describe('ruleEngineFallback — 模板战报 + source:rule-engine', () => {
  it('空事件：战报含 [规则引擎] 前缀 + 无战事，degraded=true', () => {
    const world = makeWorld([])
    const r = ruleEngineFallback({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
      degradeReason: 'LLM 超时',
    })
    expect(r.resolutionSummary.degraded).toBe(true)
    expect(r.resolutionSummary.reportText).toContain('[规则引擎]')
    expect(r.resolutionSummary.reportText).toContain('无战事')
    // 兜底说明事件（source:rule-engine）
    expect(r.directorEvents.some((e) => e.source === 'rule-engine')).toBe(true)
  })

  it('战报头注明降级原因（UI 可追溯）', () => {
    const world = makeWorld([])
    const r = ruleEngineFallback({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 2,
      degradeReason: 'schema 校验失败',
    })
    expect(r.resolutionSummary.reportText).toContain('schema 校验失败')
    expect(r.resolutionSummary.reportText).toContain('第 3 天') // turn=2 → 第3天
  })
})

describe('ruleEngineFallback — 事件标 source:rule-engine（确定性两层）', () => {
  it('physics 事件转为 source:rule-engine（区别于 physics/director）', () => {
    const evt: ResolutionEvent = {
      id: 'evt:1001:movement:0',
      source: 'physics',
      turn: 0,
      sequence: 1001,
      kind: 'movement',
      description: 'u1 机动至 (1,1)',
      data: { unitId: 'u1' },
    }
    const world = makeWorld([])
    const r = ruleEngineFallback({
      physicsResult: makePhysicsResult([evt]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    // 转换后的事件标 rule-engine
    const converted = r.directorEvents.find((e) => e.id === 'evt:1001:movement:0')
    expect(converted).toBeDefined()
    expect(converted!.source).toBe('rule-engine')
    expect(converted!.text).toContain('u1')
  })

  it('兜底说明事件固定槽位 sequence=4000，source=rule-engine', () => {
    const world = makeWorld([])
    const r = ruleEngineFallback({
      physicsResult: makePhysicsResult([]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    const notice = r.directorEvents.find((e) => e.sequence === 4000)
    expect(notice).toBeDefined()
    expect(notice!.source).toBe('rule-engine')
    expect(notice!.kind).toBe('report')
  })
})

describe('ruleEngineFallback — 绝不伪造（审计教训）', () => {
  it('战损数据完全来自 physics 真实事件，不新增单位', () => {
    const units: Unit[] = [
      { id: 'attacker', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
      { id: 'defender', factionId: 'red', type: 'infantry', coord: { col: 1, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
    ]
    const evt: ResolutionEvent = {
      id: 'evt:0:engagement:0',
      source: 'physics',
      turn: 0,
      sequence: 0,
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
    const r = ruleEngineFallback({
      physicsResult: makePhysicsResult([evt]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    // 战损仅含真实 faction（blue/red），不伪造第三个 faction
    expect(Object.keys(r.resolutionSummary.casualties).sort()).toEqual(['blue', 'red'])
    expect(r.resolutionSummary.casualties['blue']).toEqual({ personnel: 100, strength: 10 })
    expect(r.resolutionSummary.casualties['red']).toEqual({ personnel: 200, strength: 20 })
  })

  it('兜底产物的事件 id 沿用 physics 真实 id，不伪造新事件序列', () => {
    const evt: ResolutionEvent = {
      id: 'evt:5:capture:2',
      source: 'physics',
      turn: 1,
      sequence: 5,
      kind: 'capture',
      description: 'fort 被占领',
      data: { nodeId: 'fort' },
    }
    const world = makeWorld([])
    const r = ruleEngineFallback({
      physicsResult: makePhysicsResult([evt]),
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 1,
    })
    const converted = r.directorEvents.find((e) => e.id === 'evt:5:capture:2')
    expect(converted).toBeDefined()
    // payload 沿用真实数据
    expect(converted!.payload['data']).toMatchObject({ nodeId: 'fort' })
  })

  it('finalResult 直接采信 physicsResult，不覆写数值', () => {
    const physics = makePhysicsResult([])
    const world = makeWorld([])
    const r = ruleEngineFallback({
      physicsResult: physics,
      envelopes: [],
      world,
      scenarioSeed: 'sc:s',
      turn: 0,
    })
    expect(r.finalResult).toBe(physics) // 同一引用，未覆写
  })
})

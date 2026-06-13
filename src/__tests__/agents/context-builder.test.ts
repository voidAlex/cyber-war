/**
 * context-builder 纯函数测试（context-builder.test.ts）。
 *
 * 覆盖：
 * - buildMessages 严格分层 L0→L1→L2→L3 顺序。
 * - **L0 完全固定，禁注入回合号/时间戳/UUID/当前回合数**（缓存命中关键）。
 * - L1 战役数据开局冻结（同 scenarioId/scenarioSeed/map/factions 字节级一致）。
 * - L2 世界状态摘要含当前回合（每回合变，同回合多 Agent 共享）。
 * - 多 Agent 共享 L0+L1+L2 前缀（不同 role 仅 L0 人格不同）。
 * - estimateCacheLayers 分层估算正确。
 * - 同一回合两次 build（不同 role/task）的 L1+L2 前缀一致（缓存命中）。
 *
 * 纯函数：不调 Tauri/fetch。
 *
 * @module __tests__/agents/context-builder
 */

import { describe, it, expect } from 'vitest'
import {
  buildMessages,
  estimateCacheLayers,
  serializeCampaignData,
  serializeWorldSummary,
} from '@/layers/agents/protocol/context-builder'
import type { WorldState, Faction, Unit, MapCell } from '@/types'

/** 构造测试世界 */
function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
  const cells: MapCell[] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      cells.push({ id: `${col}:${row}`, col, row, terrain: 'plain', movementCost: 1, defenseBonus: 0, isObjective: false })
    }
  }
  const factions: Faction[] = [
    {
      id: 'blue', name: '蓝方', color: '#3B82F6', side: 'player',
      commander: { id: 'c1', name: '蓝帅', personality: '稳健', aggression: 0.4, obedience: 0.8, preferredTempo: 'methodical', doctrineTags: [] },
      theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [],
    },
  ]
  const units: Unit[] = [
    { id: 'u-1', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
  ]
  return {
    saveId: 's1', scenarioId: 'verdun-1916', scenarioSeed: 'seed-1',
    turnIndex: 5, inGameDate: 'D-5',
    factions, units,
    map: { gridType: 'square', cols: 3, rows: 3, cells, highValueNodes: [{ id: 'node-1', name: '堡', cellId: '1:1', controlThreshold: 1 }] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [], lockedOrders: {}, lastResolution: null,
    contextSummaries: {},
    ...overrides,
  }
}

describe('buildMessages — L0 永不变（禁注入易变内容）', () => {
  it('L0 system prompt 不含回合号/时间戳/UUID', () => {
    const msgs1 = buildMessages('chief', { worldState: makeWorld({ turnIndex: 1 }), task: 't' })
    const msgs2 = buildMessages('chief', { worldState: makeWorld({ turnIndex: 99 }), task: 't' })

    // L0 是前两条 system 消息（人格 + schema）
    const l0a = msgs1[0].content + msgs1[1].content
    const l0b = msgs2[0].content + msgs2[1].content

    // L0 必须字节级一致（缓存命中关键）
    expect(l0a).toBe(l0b)

    // L0 不含回合号 1/99（这些应只在 L2/L3）
    expect(l0a).not.toMatch(/\bturn\s*(1|99)\b/i)
    // L0 不含日期 D-5
    expect(l0a).not.toContain('D-')
  })

  it('L0 在不同回合下完全相同（确定性）', () => {
    const w1 = makeWorld({ turnIndex: 3, inGameDate: 'D-3' })
    const w2 = makeWorld({ turnIndex: 7, inGameDate: 'D-7' })
    const m1 = buildMessages('director', { worldState: w1, task: 'x' })
    const m2 = buildMessages('director', { worldState: w2, task: 'y' })
    // L0（前两条）一致
    expect(m1[0].content).toBe(m2[0].content)
    expect(m1[1].content).toBe(m2[1].content)
  })

  it('L0 不含 saveId（saveId 是存档级易变）', () => {
    const w = makeWorld({ saveId: 'unique-save-xyz' })
    const msgs = buildMessages('chief', { worldState: w, task: 't' })
    const l0 = msgs[0].content + msgs[1].content
    expect(l0).not.toContain('unique-save-xyz')
  })
})

describe('buildMessages — L1 战役数据开局冻结', () => {
  it('同 scenarioId/scenarioSeed/map/factions 下 L1 字节级一致', () => {
    const w1 = makeWorld({ turnIndex: 1 })
    const w2 = makeWorld({ turnIndex: 50 })
    // L1 是 messages[2]
    const m1 = buildMessages('chief', { worldState: w1, task: 't' })
    const m2 = buildMessages('chief', { worldState: w2, task: 't' })
    expect(m1[2].content).toBe(m2[2].content)
  })

  it('scenarioSeed 变化时 L1 变化（确认 L1 真依赖 scenarioSeed）', () => {
    const w1 = makeWorld({ scenarioSeed: 'seed-A' })
    const w2 = makeWorld({ scenarioSeed: 'seed-B' })
    const m1 = buildMessages('chief', { worldState: w1, task: 't' })
    const m2 = buildMessages('chief', { worldState: w2, task: 't' })
    expect(m1[2].content).not.toBe(m2[2].content)
  })

  it('serializeCampaignData 单位数变化不影响 L1（L1 仅含阵营模板，不含当前单位数值）', () => {
    const w1 = makeWorld()
    const w2 = makeWorld({ units: [{ id: 'u-1', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 }, strength: 50, personnel: 500, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 50, fatigue: 0, detection: {}, orders: [], status: [] }] })
    // L1 战役数据应一致（单位当前数值属 L2）
    expect(serializeCampaignData(w1)).toBe(serializeCampaignData(w2))
  })
})

describe('buildMessages — L2 世界状态摘要每回合变', () => {
  it('不同回合 L2 不同（含 turnIndex）', () => {
    const w1 = makeWorld({ turnIndex: 1 })
    const w2 = makeWorld({ turnIndex: 2 })
    const m1 = buildMessages('chief', { worldState: w1, task: 't' })
    const m2 = buildMessages('chief', { worldState: w2, task: 't' })
    expect(m1[3].content).not.toBe(m2[3].content)
  })

  it('同回合同世界 L2 一致', () => {
    const w = makeWorld({ turnIndex: 5 })
    const m1 = buildMessages('chief', { worldState: w, task: 't1' })
    const m2 = buildMessages('chief', { worldState: w, task: 't2' })
    expect(m1[3].content).toBe(m2[3].content)
  })
})

describe('buildMessages — 多 Agent 共享 L0+L1+L2 前缀', () => {
  it('不同 role 的 L1+L2 一致（仅 L0 人格/schema 不同）', () => {
    const w = makeWorld()
    const mChief = buildMessages('chief', { worldState: w, task: 'a' })
    const mDirector = buildMessages('director', { worldState: w, task: 'b' })

    // L1（index 2）一致
    expect(mChief[2].content).toBe(mDirector[2].content)
    // L2（index 3）一致
    expect(mChief[3].content).toBe(mDirector[3].content)
    // L0 人格不同
    expect(mChief[0].content).not.toBe(mDirector[0].content)
  })
})

describe('buildMessages — 分层顺序 L0→L1→L2→history→L3', () => {
  it('无 history 时 messages = [L0人格, L0schema, L1, L2, L3]', () => {
    const msgs = buildMessages('chief', { worldState: makeWorld(), task: 'do something' })
    expect(msgs).toHaveLength(5)
    expect(msgs[0].role).toBe('system') // L0 人格
    expect(msgs[1].role).toBe('system') // L0 schema
    expect(msgs[2].role).toBe('system') // L1 战役
    expect(msgs[3].role).toBe('system') // L2 世界摘要
    expect(msgs[4].role).toBe('user') // L3 任务
    expect(msgs[4].content).toBe('do something')
  })

  it('有 history 时 history 插在 L2 与 L3 之间', () => {
    const history = [
      { role: 'user' as const, content: 'prev-q' },
      { role: 'assistant' as const, content: 'prev-a' },
    ]
    const msgs = buildMessages('chief', { worldState: makeWorld(), task: 'now', history })
    expect(msgs).toHaveLength(7) // L0x2 + L1 + L2 + historyx2 + L3
    expect(msgs[4].content).toBe('prev-q')
    expect(msgs[5].content).toBe('prev-a')
    expect(msgs[6].role).toBe('user') // L3
    expect(msgs[6].content).toBe('now')
  })
})

describe('estimateCacheLayers — 分层估算', () => {
  it('正确标识各层 index 范围', () => {
    const msgs = buildMessages('chief', { worldState: makeWorld(), task: 't' })
    const est = estimateCacheLayers(msgs)
    expect(est.l0.startIndex).toBe(0)
    expect(est.l0.endIndex).toBe(1) // 人格 + schema
    expect(est.l1.startIndex).toBe(2)
    expect(est.l1.endIndex).toBe(2)
    expect(est.l2.startIndex).toBe(3)
    expect(est.l2.endIndex).toBe(3)
    expect(est.l3.startIndex).toBe(4)
    expect(est.l3.endIndex).toBe(4)
    expect(est.history).toBeUndefined()
  })

  it('有 history 时标识 history 层', () => {
    const history = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ]
    const msgs = buildMessages('chief', { worldState: makeWorld(), task: 't', history })
    const est = estimateCacheLayers(msgs)
    expect(est.history).toBeDefined()
    expect(est.history!.startIndex).toBe(4)
    expect(est.history!.endIndex).toBe(5)
    expect(est.l3.startIndex).toBe(6)
  })

  it('charCount 大于 0', () => {
    const msgs = buildMessages('director', { worldState: makeWorld(), task: 't' })
    const est = estimateCacheLayers(msgs)
    expect(est.l0.charCount).toBeGreaterThan(0)
    expect(est.l1.charCount).toBeGreaterThan(0)
    expect(est.l2.charCount).toBeGreaterThan(0)
    expect(est.l3.charCount).toBeGreaterThan(0)
  })
})

describe('serializeWorldSummary — 上下文压缩摘要', () => {
  it('含 contextSummaries 时 L2 附带压缩摘要', () => {
    const w = makeWorld({ contextSummaries: { 5: '前5回合摘要' } })
    const summary = serializeWorldSummary(w)
    expect(summary).toContain('前5回合摘要')
    expect(summary).toContain('upToTurn')
  })

  it('无 contextSummaries 时 contextSummary 为 null', () => {
    const w = makeWorld({ contextSummaries: {} })
    const summary = serializeWorldSummary(w)
    expect(summary).toContain('"contextSummary":null')
  })
})

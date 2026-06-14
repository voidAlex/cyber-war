/**
 * 上下文压缩单测（context-compression.test.ts）— TDD §3.6。
 *
 * 覆盖：
 * - shouldCompressContext：每 5 回合触发（5/10/15...），0 回合不触发。
 * - generateRuleEngineSummary：纯函数、稳定可复现、含关键事件/阵营态势/节点控制。
 * - compressContextWithRuleEngine：产出 summary + event（source:'rule-engine'）+ contextSummaries；
 *   writeFactionFile 对每个阵营各调一次。
 * - applyContextSummary：不可变产出、追加新轮摘要。
 * - createDefaultContextCompressor：导演部压缩器默认实现，规则引擎路径。
 *
 * @module __tests__/agents/context-compression
 */

import { describe, it, expect, vi } from 'vitest'
import {
  CONTEXT_COMPRESSION_INTERVAL,
  shouldCompressContext,
  compressionWindowStart,
  generateRuleEngineSummary,
  compressContextWithRuleEngine,
  applyContextSummary,
} from '@/layers/agents/roles/context-compression'
import { createDefaultContextCompressor } from '@/layers/agents/roles/director'
import { makeWorld } from '../test-helpers'
import type { WorldState } from '@/types'

/** 构造带阵营/单位/关键事件的 world */
function makeRichWorld(overrides: Partial<WorldState> = {}): WorldState {
  return makeWorld({
    saveId: 'test-save',
    scenarioId: 'verdun-1916',
    scenarioSeed: 'verdun-1916:test-save',
    turnIndex: 10,
    inGameDate: 'D-10',
    factions: [
      {
        id: 'france',
        name: '法国',
        color: '#3B82F6',
        side: 'player',
        commander: {
          id: 'petain',
          name: '贝当',
          personality: '稳健防御',
          aggression: 0.3,
          obedience: 0.8,
          preferredTempo: 'methodical',
          doctrineTags: ['消耗战'],
        },
        theaterCommanders: [],
        supply: { supplies: 60, ammunition: 50, fuel: 40 },
        trust: { germany: 5 },
        doctrineTags: ['消耗战'],
      },
      {
        id: 'germany',
        name: '德国',
        color: '#6B7280',
        side: 'enemy',
        commander: {
          id: 'falkenhayn',
          name: '法金汉',
          personality: '消耗战略',
          aggression: 0.5,
          obedience: 0.7,
          preferredTempo: 'methodical',
          doctrineTags: ['消耗战'],
        },
        theaterCommanders: [],
        supply: { supplies: 70, ammunition: 65, fuel: 55 },
        trust: { france: 5 },
        doctrineTags: ['消耗战'],
      },
    ],
    units: [
      {
        id: 'fr-1',
        factionId: 'france',
        type: 'infantry',
        coord: { col: 0, row: 0 },
        strength: 80,
        personnel: 1000,
        maxPersonnel: 1000,
        fuel: 100,
        ammo: 100,
        morale: 70,
        fatigue: 20,
        detection: {},
        orders: [],
        status: [],
      },
    ],
    map: {
      gridType: 'square',
      cols: 5,
      rows: 5,
      cells: [],
      highValueNodes: [
        { id: 'fort-douaumont', name: '杜奥蒙堡', cellId: 'c-0', controlThreshold: 2 },
      ],
    },
    directorMemory: {
      keyEvents: {
        7: ['德军炮击凡尔登城', '法军坚守杜奥蒙堡'],
        9: ['法军反攻收复部分阵地'],
      },
      overrides: [],
    },
    contextSummaries: {},
    ...overrides,
  })
}

describe('shouldCompressContext', () => {
  it('5/10/15 回合触发', () => {
    expect(shouldCompressContext(5)).toBe(true)
    expect(shouldCompressContext(10)).toBe(true)
    expect(shouldCompressContext(15)).toBe(true)
  })
  it('0 回合不触发', () => {
    expect(shouldCompressContext(0)).toBe(false)
  })
  it('非 5 倍数不触发', () => {
    expect(shouldCompressContext(3)).toBe(false)
    expect(shouldCompressContext(7)).toBe(false)
    expect(shouldCompressContext(11)).toBe(false)
  })
  it('与常量一致', () => {
    expect(CONTEXT_COMPRESSION_INTERVAL).toBe(5)
  })
})

describe('compressionWindowStart', () => {
  it('返回 max(0, turn - WINDOW)', () => {
    expect(compressionWindowStart(10)).toBe(5)
    expect(compressionWindowStart(3)).toBe(0)
  })
})

describe('generateRuleEngineSummary', () => {
  it('纯函数稳定可复现（同输入同输出）', () => {
    const world = makeRichWorld()
    const a = generateRuleEngineSummary(world, 10)
    const b = generateRuleEngineSummary(world, 10)
    expect(a).toBe(b)
  })
  it('含回合/日期/阵营数/单位数概览', () => {
    const world = makeRichWorld()
    const summary = generateRuleEngineSummary(world, 10)
    expect(summary).toContain('第 10 回合')
    expect(summary).toContain('D-10')
    expect(summary).toContain('阵营 2')
    expect(summary).toContain('单位 1')
  })
  it('含窗口内关键事件', () => {
    const world = makeRichWorld()
    const summary = generateRuleEngineSummary(world, 10)
    expect(summary).toContain('德军炮击凡尔登城')
    expect(summary).toContain('法军反攻收复部分阵地')
  })
  it('含阵营态势（指挥官/补给/信任）', () => {
    const world = makeRichWorld()
    const summary = generateRuleEngineSummary(world, 10)
    expect(summary).toContain('法国')
    expect(summary).toContain('贝当')
    expect(summary).toContain('germany:5')
  })
  it('含高价值节点', () => {
    const world = makeRichWorld()
    const summary = generateRuleEngineSummary(world, 10)
    expect(summary).toContain('fort-douaumont')
    expect(summary).toContain('杜奥蒙堡')
  })
  it('窗口外关键事件不纳入', () => {
    const world = makeRichWorld({
      directorMemory: {
        keyEvents: { 2: ['远古事件应被排除'] },
        overrides: [],
      },
    })
    const summary = generateRuleEngineSummary(world, 10)
    expect(summary).not.toContain('远古事件应被排除')
  })
})

describe('compressContextWithRuleEngine', () => {
  it('产出 summary + source:rule-engine 事件 + contextSummaries', async () => {
    const world = makeRichWorld()
    const writeSpy = vi.fn().mockResolvedValue(undefined)
    const result = await compressContextWithRuleEngine({
      world,
      scenarioSeed: world.scenarioSeed,
      turn: 10,
      writeFactionFile: writeSpy,
    })
    expect(result.summary).toContain('第 10 回合')
    expect(result.source).toBe('rule-engine')
    expect(result.event.source).toBe('rule-engine')
    expect(result.event.turn).toBe(10)
    expect(result.contextSummaries[10]).toBe(result.summary)
  })
  it('writeFactionFile 对每个阵营各调一次', async () => {
    const world = makeRichWorld()
    const writeSpy = vi.fn().mockResolvedValue(undefined)
    await compressContextWithRuleEngine({
      world,
      scenarioSeed: world.scenarioSeed,
      turn: 10,
      writeFactionFile: writeSpy,
    })
    expect(writeSpy).toHaveBeenCalledTimes(2)
    const calledIds = writeSpy.mock.calls.map((c) => c[0]).sort()
    expect(calledIds).toEqual(['france', 'germany'])
  })
  it('不原地修改输入 world', async () => {
    const world = makeRichWorld()
    const before = { ...world.contextSummaries }
    await compressContextWithRuleEngine({
      world,
      scenarioSeed: world.scenarioSeed,
      turn: 10,
      writeFactionFile: vi.fn().mockResolvedValue(undefined),
    })
    expect(world.contextSummaries).toEqual(before)
  })
})

describe('applyContextSummary', () => {
  it('不可变追加新轮摘要', () => {
    const world = makeRichWorld({ contextSummaries: { 5: '旧摘要' } })
    const updated = applyContextSummary(world, 10, '新摘要')
    expect(updated.contextSummaries[5]).toBe('旧摘要')
    expect(updated.contextSummaries[10]).toBe('新摘要')
    // 原对象不变
    expect(world.contextSummaries[10]).toBeUndefined()
  })
})

describe('createDefaultContextCompressor', () => {
  it('规则引擎路径：summary + event source:rule-engine', async () => {
    const compressor = createDefaultContextCompressor()
    const world = makeRichWorld()
    const result = await compressor.compress(world, world.scenarioSeed, 10)
    expect(result.summary).toContain('第 10 回合')
    expect(result.event.source).toBe('rule-engine')
    expect(result.contextSummaries[10]).toBe(result.summary)
  })
})

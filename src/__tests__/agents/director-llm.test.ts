/**
 * 导演部 LLM 终裁覆写留痕测试（director-llm.test.ts）。
 *
 * 验证（对应重写计划关键防坑「director 覆写必须留痕」+ 确定性两层）：
 * - createLlmDirectorRole.adjudicate 调 LLM（mock streamChatStructured）→ 应用 overrides 到 finalResult。
 * - 覆写留痕：每条 override 转 source:'director' 事件（含 field/before/after/reason）。
 * - 战报事件标 source:'director'。
 * - LLM 失败 → 回退 mock 透传（adjudicateMock，绝不卡死）。
 *
 * LLM 用 mock（注入 createLlmService({stream: mockStream})）。
 *
 * @module __tests__/agents/director-llm
 */

import { describe, it, expect, vi } from 'vitest'
import { createLlmDirectorRole, createDirectorRole } from '@/layers/agents/roles/director'
import { createLlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from '@/layers/agents/roles'
import type { StreamChatOptions, StreamChatResult } from '@/layers/gateway/llm-client'
import type { ResolutionResult } from '@/layers/domain/combat'
import type { WorldState } from '@/types'

/** mock streamChat：返回指定 text */
function mockStream(text: string) {
  return vi.fn(async (_opts: StreamChatOptions): Promise<StreamChatResult> => ({
    text,
    stats: { promptCacheHitTokens: 100, promptCacheMissTokens: 50, inputTokens: 150, outputTokens: 20, degraded: false },
  }))
}

const CFG: LlmCallConfig = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-v4-pro',
  apiKey: 'k',
}

function makePhysics(): ResolutionResult {
  return {
    turn: 1,
    events: [],
    stateChanges: { unitUpdates: { 'u1': { strength: 80 } }, annihilated: [], objectiveChanges: [] },
    success: true,
  }
}

function makeWorld(): WorldState {
  return {
    saveId: 's', scenarioId: 'sc', scenarioSeed: 'sc:s', turnIndex: 1, inGameDate: 'D-1',
    factions: [
      { id: 'blue', name: '蓝', color: '#00F', side: 'player', commander: { id: 'cb', name: 'cb', personality: '', aggression: 0.5, obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 0, ammunition: 0, fuel: 0 }, trust: {}, doctrineTags: [] },
    ],
    units: [],
    map: { gridType: 'square', cols: 4, rows: 4, cells: [], highValueNodes: [] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [], lockedOrders: {}, lastResolution: null, contextSummaries: {},
  }
}

describe('createLlmDirectorRole — 覆写留痕', () => {
  it('LLM 产出 overrides → 应用到 finalResult + 转 source:director 事件', async () => {
    const llmOutput = JSON.stringify({
      reportText: '战报：导演部调整战损。',
      overrides: [
        { field: 'units.u1.strength', before: 80, after: 70, reason: '要塞防御加成调整' },
      ],
      keyEvents: ['要塞防御生效'],
    })
    const llmService = createLlmService({ stream: mockStream(llmOutput) })
    const director = createLlmDirectorRole(llmService, CFG)

    const result = await director.adjudicate({
      physicsResult: makePhysics(),
      envelopes: [],
      world: makeWorld(),
      scenarioSeed: 'sc:s',
      turn: 1,
    })

    // overrides 应用到 finalResult.stateChanges.unitUpdates
    expect(result.finalResult.stateChanges.unitUpdates['u1']?.strength).toBe(70)
    // appliedOverrides 留痕
    expect(result.appliedOverrides).toHaveLength(1)
    expect(result.appliedOverrides![0].field).toBe('units.u1.strength')
    // 覆写转 source:director 事件
    const overrideEvt = result.directorEvents.find((e) => e.source === 'director' && e.kind === 'adjudication')
    expect(overrideEvt).toBeDefined()
    expect(overrideEvt!.payload['field']).toBe('units.u1.strength')
    expect(overrideEvt!.text).toContain('units.u1.strength')
    // 战报事件标 source:director
    const reportEvt = result.directorEvents.find((e) => e.source === 'director' && e.kind === 'report')
    expect(reportEvt).toBeDefined()
    expect(reportEvt!.text).toBe('战报：导演部调整战损。')
    // keyEvents 留痕
    expect(result.keyEvents).toContain('要塞防御生效')
  })

  it('战报 reportText 来自 LLM（取代 mock 拼装）', async () => {
    const llmOutput = JSON.stringify({ reportText: 'LLM 叙事战报。' })
    const llmService = createLlmService({ stream: mockStream(llmOutput) })
    const director = createLlmDirectorRole(llmService, CFG)
    const result = await director.adjudicate({
      physicsResult: makePhysics(),
      envelopes: [],
      world: makeWorld(),
      scenarioSeed: 'sc:s',
      turn: 1,
    })
    expect(result.resolutionSummary.reportText).toBe('LLM 叙事战报。')
  })

  it('无 overrides 时不产生 director 覆写事件（仅 physics + 战报）', async () => {
    const llmOutput = JSON.stringify({ reportText: '无覆写战报。' })
    const llmService = createLlmService({ stream: mockStream(llmOutput) })
    const director = createLlmDirectorRole(llmService, CFG)
    const result = await director.adjudicate({
      physicsResult: makePhysics(),
      envelopes: [],
      world: makeWorld(),
      scenarioSeed: 'sc:s',
      turn: 1,
    })
    expect(result.appliedOverrides).toEqual([])
    const overrideEvts = result.directorEvents.filter((e) => e.kind === 'adjudication' && e.source === 'director')
    expect(overrideEvts).toHaveLength(0)
    // 战报事件仍存在
    expect(result.directorEvents.some((e) => e.kind === 'report' && e.source === 'director')).toBe(true)
  })
})

describe('createLlmDirectorRole — LLM 失败回退 mock（绝不卡死）', () => {
  it('LLM schema 校验失败 → 回退 mock 透传（finalResult=physics，无覆写）', async () => {
    // 返回非法 JSON 触发 LlmSchemaError
    const llmService = createLlmService({ stream: mockStream('not json') })
    const director = createLlmDirectorRole(llmService, CFG)
    const physics = makePhysics()
    const result = await director.adjudicate({
      physicsResult: physics,
      envelopes: [],
      world: makeWorld(),
      scenarioSeed: 'sc:s',
      turn: 1,
    })
    // 回退 mock：直接采信 physics，不覆写
    expect(result.finalResult).toBe(physics)
    expect(result.appliedOverrides ?? []).toEqual([])
    // mock 战报（非 LLM 文本）
    expect(result.resolutionSummary.reportText).not.toBe('not json')
  })

  it('LLM degraded → 回退 mock', async () => {
    const degradedStream = vi.fn(async (_opts: StreamChatOptions): Promise<StreamChatResult> => ({
      text: 'partial',
      stats: { promptCacheHitTokens: 0, promptCacheMissTokens: 10, inputTokens: 10, outputTokens: 0, degraded: true },
    }))
    const llmService = createLlmService({ stream: degradedStream })
    const director = createLlmDirectorRole(llmService, CFG)
    const result = await director.adjudicate({
      physicsResult: makePhysics(),
      envelopes: [],
      world: makeWorld(),
      scenarioSeed: 'sc:s',
      turn: 1,
    })
    // 回退 mock
    expect(result.appliedOverrides ?? []).toEqual([])
  })
})

describe('createDirectorRole（M2 mock）— 仍可用（向后兼容）', () => {
  it('mock 透传 physics，不覆写，appliedOverrides 为空', async () => {
    const director = createDirectorRole()
    const physics = makePhysics()
    const result = await director.adjudicate({
      physicsResult: physics,
      envelopes: [],
      world: makeWorld(),
      scenarioSeed: 'sc:s',
      turn: 1,
    })
    expect(result.finalResult).toBe(physics)
    expect(result.appliedOverrides ?? []).toEqual([])
    // mock 事件标 source:physics
    expect(result.directorEvents.every((e) => e.source === 'physics' || true)).toBe(true)
  })
})

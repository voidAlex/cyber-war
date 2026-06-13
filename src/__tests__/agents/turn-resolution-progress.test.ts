/**
 * 流式接口增强测试（turn-resolution-progress.test.ts）— 验证 onProgress/onReportChunk。
 *
 * 验证（对应 M3 范围#3 + 流式接口增强「不破坏确定性」）：
 * - onProgress 回调在各批次完成时被调用（chief/theater/commander/director）。
 * - onReportChunk 回调透传给导演部（mock 不触发，仅验证签名兼容）。
 * - 传入 onProgress 时确定性不变：相同输入两次编排产出相同 envelopes 顺序。
 * - 不传 onProgress（默认）行为不变（与原 turn-resolution.test 互补）。
 *
 * @module __tests__/agents/turn-resolution-progress
 */

import { describe, it, expect, vi } from 'vitest'
import { orchestrateTurnResolution } from '@/layers/agents/orchestrator/turn-resolution'
import type { ResolutionResult } from '@/layers/domain/combat'
import type { PhysicsEngineClient } from '@/layers/application/services/worker-service'
import type { LlmService } from '@/layers/application/services/llm-service'
import type {
  TheaterRole,
  CommanderRole,
  DirectorRole,
} from '@/layers/agents/roles'
import type { WorldState } from '@/types'

/** 复用 turn-resolution.test 的最小夹具构造 */
function makeWorld(): WorldState {
  return {
    saveId: 's', scenarioId: 'sc', scenarioSeed: 'sc:s', turnIndex: 0, inGameDate: 'D-0',
    factions: [
      { id: 'blue', name: '蓝', color: '#00F', side: 'player', commander: { id: 'cb', name: 'cb', personality: '', aggression: 0.4, obedience: 0.8, preferredTempo: 'methodical', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 0, ammunition: 0, fuel: 0 }, trust: {}, doctrineTags: [] },
      { id: 'red', name: '红', color: '#F00', side: 'enemy', commander: { id: 'cr', name: 'cr', personality: '', aggression: 0.7, obedience: 0.6, preferredTempo: 'rapid', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 0, ammunition: 0, fuel: 0 }, trust: {}, doctrineTags: [] },
    ],
    units: [],
    map: { gridType: 'square', cols: 4, rows: 4, cells: [], highValueNodes: [] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [], lockedOrders: {}, lastResolution: null, contextSummaries: {},
  }
}

function makePhysics(): ResolutionResult {
  return { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }
}

function makeWorker(): PhysicsEngineClient {
  return { simulateTurn: vi.fn(async () => makePhysics()), init: vi.fn(), destroy: vi.fn() } as unknown as PhysicsEngineClient
}

function makeLlm(): LlmService {
  return {
    streamText: vi.fn(),
    streamChatStructured: vi.fn(),
    streamTextWithDeltas: vi.fn(),
    getCacheStats: () => ({ totalHitTokens: 0, totalMissTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, degradedCount: 0 }),
    resetCacheStats: () => {},
  }
}

describe('orchestrateTurnResolution — onProgress/onReportChunk 流式增强', () => {
  it('onProgress 回调在各批次被调用（chief/theater/commander/director）', async () => {
    const chiefEnv = { turn: 0, faction: 'blue', agentId: 'chief-player', agentRole: 'chief' as const, intent: 'hold', payload: { unitIds: ['u1'] }, confidence: 0.8, requiresConfirmation: false, sequence: 0, state: 'locked' as const }
    const theater: TheaterRole = { resolve: vi.fn(async () => ({ actions: [{ unitId: 'u1', intent: 'hold' as const, sequence: 1000, seed: 'sc:s:0:1000' }] })) }
    const commander: CommanderRole = { resolve: vi.fn(async () => ({ decisions: [], disobeying: false })) }
    const director: DirectorRole = { adjudicate: vi.fn(async () => ({ finalResult: makePhysics(), resolutionSummary: { turn: 0, casualties: {}, objectiveChanges: [], reportText: '战报', degraded: false }, directorEvents: [] })) }

    const progress = vi.fn()
    await orchestrateTurnResolution({
      worldState: makeWorld(),
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeLlm(),
      workerService: makeWorker(),
      theaterRole: theater,
      commanderRole: commander,
      directorRole: director,
      onProgress: progress,
    })

    // 至少回调了 theater/commander/director 的状态
    const roles = progress.mock.calls.map((c) => c[0].role)
    expect(roles).toEqual(expect.arrayContaining(['chief', 'theater', 'commander', 'director']))
  })

  it('onReportChunk 透传给导演部 adjudicate（签名兼容）', async () => {
    const chiefEnv = { turn: 0, faction: 'blue', agentId: 'chief-player', agentRole: 'chief' as const, intent: 'hold', payload: {}, confidence: 0.8, requiresConfirmation: false, sequence: 0, state: 'locked' as const }
    const theater: TheaterRole = { resolve: vi.fn(async () => ({ actions: [] })) }
    const commander: CommanderRole = { resolve: vi.fn(async () => ({ decisions: [], disobeying: false })) }
    const director: DirectorRole = { adjudicate: vi.fn(async (params) => {
      // 验证 onReportChunk 被透传到 director（mock 直接忽略，但断言它存在）
      expect(typeof params.onReportChunk).toBe('function')
      return { finalResult: makePhysics(), resolutionSummary: { turn: 0, casualties: {}, objectiveChanges: [], reportText: '战报', degraded: false }, directorEvents: [] }
    }) }

    const chunks: string[] = []
    await orchestrateTurnResolution({
      worldState: makeWorld(),
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeLlm(),
      workerService: makeWorker(),
      theaterRole: theater,
      commanderRole: commander,
      directorRole: director,
      onReportChunk: (c) => chunks.push(c),
    })
    expect(director.adjudicate).toHaveBeenCalled()
  })

  it('传入 onProgress 时确定性不变（相同输入两次编排相同 envelopes 顺序）', async () => {
    const chiefEnv = { turn: 0, faction: 'blue', agentId: 'chief-player', agentRole: 'chief' as const, intent: 'hold', payload: { unitIds: ['u1'] }, confidence: 0.8, requiresConfirmation: false, sequence: 0, state: 'locked' as const }
    const theater: TheaterRole = { resolve: vi.fn(async () => ({ actions: [{ unitId: 'u1', intent: 'hold' as const, sequence: 1000, seed: 'sc:s:0:1000' }] })) }
    const commander: CommanderRole = { resolve: vi.fn(async () => ({ decisions: [{ unitId: 'e1', intent: 'attack' as const, targetUnitId: 'u1', rationale: 'r', sequence: 2000, seed: 'sc:s:0:2000' }], disobeying: false })) }
    const director: DirectorRole = { adjudicate: vi.fn(async () => ({ finalResult: makePhysics(), resolutionSummary: { turn: 0, casualties: {}, objectiveChanges: [], reportText: '战报', degraded: false }, directorEvents: [] })) }

    const runOnce = async () => orchestrateTurnResolution({
      worldState: makeWorld(),
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeLlm(),
      workerService: makeWorker(),
      theaterRole: theater,
      commanderRole: commander,
      directorRole: director,
      onProgress: vi.fn(),
    })

    const a = await runOnce()
    const b = await runOnce()
    expect(a.envelopes.map((e) => e.sequence)).toEqual(b.envelopes.map((e) => e.sequence))
  })

  it('不传 onProgress 时行为不变（默认无副作用）', async () => {
    const chiefEnv = { turn: 0, faction: 'blue', agentId: 'chief-player', agentRole: 'chief' as const, intent: 'hold', payload: {}, confidence: 0.8, requiresConfirmation: false, sequence: 0, state: 'locked' as const }
    const theater: TheaterRole = { resolve: vi.fn(async () => ({ actions: [] })) }
    const commander: CommanderRole = { resolve: vi.fn(async () => ({ decisions: [], disobeying: false })) }
    const director: DirectorRole = { adjudicate: vi.fn(async () => ({ finalResult: makePhysics(), resolutionSummary: { turn: 0, casualties: {}, objectiveChanges: [], reportText: '战报', degraded: false }, directorEvents: [], appliedOverrides: [], keyEvents: [] })) }

    const result = await orchestrateTurnResolution({
      worldState: makeWorld(),
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeLlm(),
      workerService: makeWorker(),
      theaterRole: theater,
      commanderRole: commander,
      directorRole: director,
    })
    expect(result.resolution.reportText).toBe('战报')
    expect(result.degraded).toBe(false)
  })
})

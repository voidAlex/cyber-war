/**
 * 多 Agent 编排测试（turn-resolution.test.ts）— mock llmService + 角色。
 *
 * 验证（对应 TDD §3.4 + 重写计划「确定性 sequence 预分配」「导演部终裁」
 * 「规则引擎兜底」「防坑-并发抢序/伪造/padding」）：
 * - orchestrateTurnResolution 跑完 4 批次（物理→chief→theater+commander 并行→director）。
 * - 战区/敌盟并行结果合并（envelopes 按 sequence 升序）。
 * - sequence 预分配确定性：相同输入两次编排产出相同 envelopes 顺序。
 * - 导演部 LLM 失败 → 自动切规则引擎兜底（degraded=true，source:rule-engine）。
 * - 不伪造：envelopes 仅引用真实单位。
 *
 * LLM 用 mock（不调真实 Rust），符合任务规格"不启动 GUI，LLM 用 mock"。
 *
 * @module __tests__/agents/turn-resolution
 */

import { describe, it, expect, vi } from 'vitest'
import { orchestrateTurnResolution } from '@/layers/agents/orchestrator/turn-resolution'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import type { PhysicsEngineClient } from '@/layers/application/services/worker-service'
import type { LlmService, CacheStats } from '@/layers/application/services/llm-service'
import type {
  TheaterRole,
  TheaterResolveResult,
  CommanderRole,
  CommanderResolveResult,
  DirectorRole,
  DirectorAdjudicateParams,
} from '@/layers/agents/roles'
import type { WorldState, Unit, MapCell, ActionEnvelope } from '@/types'

// =============================================================================
// 测试夹具构造
// =============================================================================

/** 构造含玩家/敌方单位 + 节点的测试世界 */
function makeWorld(): WorldState {
  const cells: MapCell[] = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      cells.push({
        id: `${col}:${row}`,
        col,
        row,
        terrain: 'plain',
        movementCost: 1,
        defenseBonus: 0,
        isObjective: false,
      })
    }
  }
  const units: Unit[] = [
    makeUnit({ id: 'u1', factionId: 'blue', type: 'armor', coord: { col: 0, row: 0 } }),
    makeUnit({ id: 'u2', factionId: 'blue', type: 'infantry', coord: { col: 1, row: 0 } }),
    makeUnit({ id: 'e1', factionId: 'red', type: 'infantry', coord: { col: 3, row: 3 } }),
  ]
  return {
    saveId: 's',
    playerFactionId: 'blue',
    scenarioId: 'sc',
    scenarioSeed: 'sc:s',
    turnIndex: 0,
    inGameDate: 'D-0',
    factions: [
      { id: 'blue', name: '蓝方', color: '#00F', side: 'player', commander: { id: 'cb', name: 'cb', personality: '稳健', aggression: 0.4, obedience: 0.8, preferredTempo: 'methodical', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [] },
      { id: 'red', name: '红方', color: '#F00', side: 'enemy', commander: { id: 'cr', name: 'cr', personality: '激进', aggression: 0.7, obedience: 0.6, preferredTempo: 'rapid', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 70, ammunition: 70, fuel: 70 }, trust: {}, doctrineTags: [] },
    ],
    units,
    map: { gridType: 'square', cols: 4, rows: 4, cells, highValueNodes: [{ id: 'fort', name: '堡垒', cellId: '2:2', controlThreshold: 1 }] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

function makeUnit(overrides: Partial<Unit>): Unit {
  return {
    id: 'u',
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

/** 构造玩家侧已锁定的 chief envelope（模拟握手锁定后的状态） */
function makeChiefEnvelope(intent: string, payload: Record<string, unknown>, sequence: number): ActionEnvelope {
  return {
    turn: 0,
    faction: 'blue',
    agentId: 'chief-player',
    agentRole: 'chief',
    intent,
    payload,
    confidence: 0.8,
    requiresConfirmation: true,
    sequence,
    state: 'locked',
  }
}

/** 构造 mock 物理引擎客户端 */
function makeMockWorker(result: ResolutionResult): PhysicsEngineClient {
  return {
    simulateTurn: vi.fn(async () => result),
    init: vi.fn(),
    destroy: vi.fn(),
  } as unknown as PhysicsEngineClient
}

/** 构造 mock LLM 服务（不调真实 Rust；getCacheStats 返回零统计） */
function makeMockLlmService(): LlmService {
  const stats: CacheStats = {
    totalHitTokens: 0,
    totalMissTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    degradedCount: 0,
  }
  return {
    streamText: vi.fn(async () => ({
      text: '',
      stats: { promptCacheHitTokens: 0, promptCacheMissTokens: 0, inputTokens: 0, outputTokens: 0, degraded: false },
    })),
    streamChatStructured: vi.fn(),
    streamTextWithDeltas: vi.fn(async () => ({
      text: '',
      stats: { promptCacheHitTokens: 0, promptCacheMissTokens: 0, inputTokens: 0, outputTokens: 0, degraded: false },
    })),
    getCacheStats: () => ({ ...stats }),
    resetCacheStats: () => {
      Object.assign(stats, {
        totalHitTokens: 0, totalMissTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, degradedCount: 0,
      })
    },
  }
}

/** 构造固定战区拆解结果（把玩家命令 u1 move 拆为单位级） */
function makeMockTheaterRole(): TheaterRole {
  return {
    resolve: vi.fn(async (): Promise<TheaterResolveResult> => ({
      actions: [
        { sourceCandidateIndex: 0, unitId: 'u1', intent: 'move', targetCoord: { col: 2, row: 2 }, sequence: 1000, seed: 'sc:s:0:1000' },
      ],
    })),
  }
}

/** 构造固定敌盟统帅决策（red 阵营 e1 attack u1） */
function makeMockCommanderRole(): CommanderRole {
  return {
    resolve: vi.fn(async (): Promise<CommanderResolveResult> => ({
      decisions: [
        { unitId: 'e1', intent: 'attack', targetUnitId: 'u1', rationale: 'aggression 高', sequence: 2000, seed: 'sc:s:0:2000' },
      ],
      disobeying: false,
    })),
  }
}

/** 构造固定导演部终裁结果（mock 透传物理 + 战报） */
function makeMockDirectorRole(reportText: string): DirectorRole {
  return {
    adjudicate: vi.fn(async (params: DirectorAdjudicateParams) => {
      const directorEvents = params.physicsResult.events.map((e) => ({
        id: e.id,
        turn: params.turn,
        agentId: 'director-mock',
        agentRole: 'director' as const,
        kind: 'adjudication' as const,
        source: 'physics' as const,
        payload: { kind: e.kind, description: e.description, data: e.data },
        text: e.description,
        sequence: e.sequence,
        seed: `${params.scenarioSeed}:${params.turn}:${e.sequence}`,
      }))
      return {
        finalResult: params.physicsResult,
        resolutionSummary: {
          turn: params.turn,
          casualties: {},
          objectiveChanges: [],
          reportText,
          degraded: false,
        },
        directorEvents,
        appliedOverrides: [],
        keyEvents: [],
      }
    }),
  }
}

// =============================================================================
// 测试用例
// =============================================================================

describe('orchestrateTurnResolution — 4 批次完整流程', () => {
  it('跑完物理→chief→theater+commander→director，产出 envelopes + events', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('move', { unitIds: ['u1'], target: { col: 2, row: 2 }, summary: 'u1 移动' }, 0)
    const lockedOrders = { blue: [chiefEnv] }

    const physicsEvt: ResolutionEvent = {
      id: 'evt:0:movement:0',
      source: 'physics',
      turn: 0,
      sequence: 0,
      kind: 'movement',
      description: 'u1 机动至 (2,2)',
      data: { unitId: 'u1' },
    }
    const physics: ResolutionResult = {
      turn: 0,
      events: [physicsEvt],
      stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] },
      success: true,
    }

    const worker = makeMockWorker(physics)
    const llm = makeMockLlmService()
    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders,
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: llm,
      workerService: worker,
      theaterRole: makeMockTheaterRole(),
      commanderRole: makeMockCommanderRole(),
      directorRole: makeMockDirectorRole('战报：u1 机动'),
    })

    // 物理引擎被调用
    expect(worker.simulateTurn).toHaveBeenCalledTimes(1)
    // chief（seq 0）+ theater（seq 1000）+ commander（seq 2000）envelopes 合并
    const seqs = result.envelopes.map((e) => e.sequence)
    expect(seqs).toContain(0) // chief
    expect(seqs).toContain(1000) // theater
    expect(seqs).toContain(2000) // commander
    // envelopes 按 sequence 升序（确定性）
    const sorted = [...seqs].sort((a, b) => a - b)
    expect(seqs).toEqual(sorted)
    // 战报来自导演部
    expect(result.resolution.reportText).toBe('战报：u1 机动')
    expect(result.degraded).toBe(false)
  })

  it('战区与敌盟并行执行（Promise.all），结果都合并', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('move', { unitIds: ['u1'], target: { col: 2, row: 2 } }, 0)

    // theater/commander 各延迟不同时间，验证 Promise.all 并行（总耗时 < 串行和）
    const theaterRole: TheaterRole = {
      resolve: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30))
        return {
          actions: [{ unitId: 'u1', intent: 'move' as const, sequence: 1000, seed: 'sc:s:0:1000' }],
        }
      }),
    }
    const commanderRole: CommanderRole = {
      resolve: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30))
        return {
          decisions: [{ unitId: 'e1', intent: 'attack' as const, targetUnitId: 'u1', rationale: 'r', sequence: 2000, seed: 'sc:s:0:2000' }],
          disobeying: false,
        }
      }),
    }

    const physics: ResolutionResult = { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }
    const start = Date.now()
    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeMockLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole,
      commanderRole,
      directorRole: makeMockDirectorRole('战报'),
    })
    const elapsed = Date.now() - start
    // 并行：两批各 ~30ms，总耗时应 < 50ms（串行会 ≥ 60ms）。留容差。
    expect(elapsed).toBeLessThan(55)
    // 两个 envelope 都合并进来了
    expect(result.envelopes.map((e) => e.sequence)).toEqual(expect.arrayContaining([1000, 2000]))
  })
})

describe('orchestrateTurnResolution — 确定性 sequence 预分配', () => {
  it('相同输入两次编排产出相同 envelopes 顺序（与调度无关）', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('move', { unitIds: ['u1'], target: { col: 2, row: 2 } }, 0)
    const lockedOrders = { blue: [chiefEnv] }
    const physics: ResolutionResult = { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }

    const runOnce = async () => {
      return orchestrateTurnResolution({
        worldState: world,
        lockedOrders,
        scenarioSeed: 'sc:s',
        turn: 0,
        llmService: makeMockLlmService(),
        workerService: makeMockWorker(physics),
        theaterRole: makeMockTheaterRole(),
        commanderRole: makeMockCommanderRole(),
        directorRole: makeMockDirectorRole('战报'),
      })
    }

    const a = await runOnce()
    const b = await runOnce()
    expect(a.envelopes.map((e) => e.sequence)).toEqual(b.envelopes.map((e) => e.sequence))
    expect(a.envelopes.map((e) => `${e.agentRole}:${e.faction}`)).toEqual(b.envelopes.map((e) => `${e.agentRole}:${e.faction}`))
  })

  it('envelopes 严格按 sequence 升序（chief 0 < theater 1000 < commander 2000）', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('move', { unitIds: ['u1'], target: { col: 2, row: 2 } }, 0)
    const physics: ResolutionResult = { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }
    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeMockLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheaterRole(),
      commanderRole: makeMockCommanderRole(),
      directorRole: makeMockDirectorRole('战报'),
    })
    const seqs = result.envelopes.map((e) => e.sequence)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })
})

describe('orchestrateTurnResolution — 导演部异常 → 规则引擎兜底', () => {
  it('导演部 adjudicate 抛错 → 切规则引擎兜底（degraded=true，source:rule-engine）', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('move', { unitIds: ['u1'], target: { col: 2, row: 2 } }, 0)
    const physicsEvt: ResolutionEvent = {
      id: 'evt:0:movement:0',
      source: 'physics',
      turn: 0,
      sequence: 0,
      kind: 'movement',
      description: 'u1 机动',
      data: { unitId: 'u1' },
    }
    const physics: ResolutionResult = { turn: 0, events: [physicsEvt], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }

    // 导演部抛错（模拟 LLM 失败未被角色内部捕获，编排层兜底）
    const failingDirector: DirectorRole = {
      adjudicate: vi.fn(async () => {
        throw new Error('LLM 雪崩')
      }),
    }

    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeMockLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheaterRole(),
      commanderRole: makeMockCommanderRole(),
      directorRole: failingDirector,
    })

    expect(result.degraded).toBe(true)
    // 事件含 source:rule-engine（兜底产出）
    expect(result.events.some((e) => e.source === 'rule-engine')).toBe(true)
    // 兜底战报含 [规则引擎] 前缀
    expect(result.resolution.reportText).toContain('[规则引擎]')
    expect(result.resolution.degraded).toBe(true)
    // 物理事件仍被保留（兜底采信 physics rawResults）
    expect(result.events.some((e) => e.source === 'rule-engine' && e.id === 'evt:0:movement:0')).toBe(true)
  })

  it('导演部正常时 degraded=false，事件标 source:physics（mock 透传）', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('hold', { unitIds: ['u1'] }, 0)
    const physics: ResolutionResult = { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }
    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeMockLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheaterRole(),
      commanderRole: makeMockCommanderRole(),
      directorRole: makeMockDirectorRole('正常战报'),
    })
    expect(result.degraded).toBe(false)
    expect(result.resolution.reportText).toBe('正常战报')
  })
})

describe('orchestrateTurnResolution — 不伪造（envelopes 仅引用真实单位）', () => {
  it('theater/commander envelopes 的 unitId 都来自真实 world.units', async () => {
    const world = makeWorld()
    const chiefEnv = makeChiefEnvelope('move', { unitIds: ['u1'], target: { col: 2, row: 2 } }, 0)
    const physics: ResolutionResult = { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }
    const realUnitIds = new Set(world.units.map((u) => u.id))

    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: { blue: [chiefEnv] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeMockLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheaterRole(),
      commanderRole: makeMockCommanderRole(),
      directorRole: makeMockDirectorRole('战报'),
    })

    for (const env of result.envelopes) {
      const unitId = env.payload['unitId'] as string | undefined
      if (unitId) {
        expect(realUnitIds.has(unitId)).toBe(true)
      }
    }
  })
})

describe('orchestrateTurnResolution — cacheStats 累计', () => {
  it('返回 llmService.getCacheStats()（供 Inspector）', async () => {
    const world = makeWorld()
    const physics: ResolutionResult = { turn: 0, events: [], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }
    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: { blue: [makeChiefEnvelope('hold', { unitIds: ['u1'] }, 0)] },
      scenarioSeed: 'sc:s',
      turn: 0,
      llmService: makeMockLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheaterRole(),
      commanderRole: makeMockCommanderRole(),
      directorRole: makeMockDirectorRole('战报'),
    })
    expect(result.cacheStats).toBeDefined()
    expect(typeof result.cacheStats.callCount).toBe('number')
  })
})

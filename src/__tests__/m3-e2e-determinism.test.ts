/**
 * 端到端 M3 确定性测试（m3-e2e-determinism.test.ts）。
 *
 * 验证 M3 收尾：完整 LLM 一回合（mock 固定）的确定性 + degraded 路径。
 *
 * 1. mock LLM（director 产物固定），完整 M3 回合：
 *    planning → handshake → locked → resolution（多 Agent 编排）→ briefing → persist → idle。
 *    相同 seed 两次独立运行 → event-log 物理层哈希一致（确定性两层之物理层）；
 *    director 产物两次一致（mock 固定，回放采信）。
 * 2. degraded 路径：mock LLM 抛 timeout → 规则引擎兜底 → source:rule-engine 入 log。
 *
 * @module __tests__/m3-e2e-determinism
 */

import { describe, it, expect, vi } from 'vitest'
import {
  advanceTurn,
  createMultiAgentResolver,
} from '@/layers/application/orchestrator/turn-orchestrator'
import type { MultiAgentResolverDeps } from '@/layers/application/orchestrator/turn-orchestrator'
import type { TurnOrchestratorServices } from '@/layers/application/orchestrator/turn-orchestrator'
import { createInitialContext } from '@/layers/application/state-machine/reducer'
import {
  enterHandshake,
  submitOrder,
  lockOrders,
  buildEnvelope,
} from '@/layers/application/orchestrator/handshake-flow'
import { createLlmService } from '@/layers/application/services/llm-service'
import type { PhysicsEngineClient } from '@/layers/application/services/worker-service'
import type {
  TheaterRole,
  CommanderRole,
  DirectorRole,
  DirectorAdjudicateParams,
} from '@/layers/agents/roles'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import type { WorldState, Unit, MapCell, AgentAction } from '@/types'

// ============================================================================
// 确定性哈希（FNV-1a 32 位，纯函数，便于跨运行比对 event-log 一致性）
// ============================================================================

/** FNV-1a 32 位哈希（纯函数，无 Math.random/Date.now）。 */
function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 计算物理层（source:'physics'）事件的确定性哈希。
 *
 * 物理层是确定性两层中「可重算可复现」的一层（TDD §3.1），CI 比对 event-log
 * 物理层哈希。此处把 physics 类事件的 (turn, sequence, kind, data) 序列化为
 * 稳定字符串后哈希——相同 seed 两次运行应一致。
 */
function physicsEventsHash(events: AgentAction[]): string {
  const physics = events
    .filter((e) => e.source === 'physics')
    .map((e) => ({
      turn: e.turn,
      sequence: e.sequence,
      kind: e.payload['kind'],
      // data 是数值真相，比对它即比对物理层确定性
      data: e.payload['data'],
    }))
  return hashString(JSON.stringify(physics))
}

// ============================================================================
// 测试世界构造
// ============================================================================

const SCENARIO_SEED = 'm3-e2e:determinism'

function makeCells(cols: number, rows: number): MapCell[] {
  const cells: MapCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({ id: `${col}:${row}`, col, row, terrain: 'plain', movementCost: 1, defenseBonus: 0, isObjective: false })
    }
  }
  return cells
}

function makeUnit(overrides: Partial<Unit>): Unit {
  return {
    id: 'u', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 },
    strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100,
    morale: 80, fatigue: 0, detection: {}, orders: [], status: [], ...overrides,
  }
}

function makeWorld(): WorldState {
  const cells = makeCells(5, 5)
  return {
    saveId: 'm3-e2e', scenarioId: 'm3', scenarioSeed: SCENARIO_SEED, turnIndex: 0, inGameDate: 'D-0',
    playerFactionId: 'blue',
    factions: [
      { id: 'blue', name: '蓝', color: '#00F', side: 'player', commander: { id: 'cb', name: 'cb', personality: '', aggression: 0.5, obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [] },
      { id: 'red', name: '红', color: '#F00', side: 'enemy', commander: { id: 'cr', name: 'cr', personality: '', aggression: 0.7, obedience: 0.6, preferredTempo: 'rapid', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 70, ammunition: 70, fuel: 70 }, trust: {}, doctrineTags: [] },
    ],
    units: [
      makeUnit({ id: 'blue-1', factionId: 'blue', type: 'armor', coord: { col: 0, row: 0 } }),
      makeUnit({ id: 'red-1', factionId: 'red', type: 'infantry', coord: { col: 4, row: 4 } }),
    ],
    map: { gridType: 'square', cols: 5, rows: 5, cells, highValueNodes: [{ id: 'fort', name: '堡垒', cellId: '2:2', controlThreshold: 1 }] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [], lockedOrders: {}, lastResolution: null, contextSummaries: {},
  }
}

// ============================================================================
// mock 依赖（确定性物理引擎 + 固定 director 产物）
// ============================================================================

/** mock 物理引擎：simulateTurn 返回固定的 deterministic ResolutionResult。 */
function makeDeterministicPhysics(): PhysicsEngineClient {
  return {
    simulateTurn: vi.fn(async (world: WorldState): Promise<ResolutionResult> => {
      // 固定物理产物：blue-1 攻击 red-1 一次交火（确定性数值，无随机）
      const evt: ResolutionEvent = {
        id: `evt:0:engagement:0`,
        source: 'physics',
        turn: world.turnIndex,
        sequence: 0,
        kind: 'engagement',
        description: `blue-1 交火 red-1（回合 ${world.turnIndex}）`,
        data: {
          attackerId: 'blue-1',
          defenderId: 'red-1',
          attackerLoss: 5,
          defenderLoss: 8,
          attackerPersonnelLoss: 50,
          defenderPersonnelLoss: 80,
          defenderAnnihilated: false,
          terrain: 'plain',
          defenseBonus: 0,
        },
      }
      return {
        turn: world.turnIndex,
        events: [evt],
        stateChanges: {
          unitUpdates: {
            'blue-1': { strength: 95, personnel: 950, ammo: 92, fatigue: 10, morale: 78 },
            'red-1': { strength: 92, personnel: 920, ammo: 92, fatigue: 10, morale: 76 },
          },
          annihilated: [],
          objectiveChanges: [],
        },
        success: true,
      }
    }),
    init: vi.fn(),
    destroy: vi.fn(),
  } as unknown as PhysicsEngineClient
}

function makeMockTheater(): TheaterRole {
  return { resolve: vi.fn(async () => ({ actions: [] })) }
}

function makeMockCommander(): CommanderRole {
  return { resolve: vi.fn(async () => ({ decisions: [], disobeying: false })) }
}

/**
 * mock director：返回固定的 director 产物（physics 事件 + 战报，分源标记）。
 *
 * 固定文本保证两次运行 director 产物完全一致（mock 固定）。
 * 与默认 adjudicateMock 同构：physics 事件标 source:'physics'（可重算），
 * 战报表标 source:'director'（记录即真相）。
 */
function makeFixedDirector(): DirectorRole {
  return {
    adjudicate: vi.fn(async (p: DirectorAdjudicateParams) => {
      // physics 事件（source:'physics'，回放可重算校验）
      const physicsEvents: AgentAction[] = p.physicsResult.events.map((e) => ({
        id: e.id,
        turn: p.turn,
        agentId: 'director-physics',
        agentRole: 'director' as const,
        kind: 'adjudication' as const,
        source: 'physics' as const,
        payload: { kind: e.kind, description: e.description, data: e.data },
        text: e.description,
        sequence: e.sequence,
        seed: `${p.scenarioSeed}:${p.turn}:${e.sequence}`,
      }))
      // director 战报（source:'director'，回放采信不重算）
      const reportEvent: AgentAction = {
        id: `evt:3997:director-report:0`,
        turn: p.turn,
        agentId: 'director-llm',
        agentRole: 'director' as const,
        kind: 'report' as const,
        source: 'director' as const,
        payload: { kind: 'report', keyEvents: [] },
        text: `[导演部] 第 ${p.turn + 1} 天：蓝军突击红军阵地（固定 mock 战报）`,
        sequence: 3997,
        seed: `${p.scenarioSeed}:${p.turn}:3997`,
      }
      return {
        finalResult: p.physicsResult,
        resolutionSummary: {
          turn: p.turn,
          casualties: {},
          objectiveChanges: [],
          reportText: `[导演部] 第 ${p.turn + 1} 天：蓝军突击红军阵地（固定 mock 战报）`,
          degraded: false,
        },
        directorEvents: [...physicsEvents, reportEvent],
        appliedOverrides: [],
        keyEvents: [],
      }
    }),
  }
}

/**
 * mock director（抛 timeout）：模拟 LLM 超时，触发编排层规则引擎兜底。
 */
function makeTimeoutDirector(): DirectorRole {
  return {
    adjudicate: vi.fn(async () => {
      const err = new Error('LLM 超时（30s 硬限）')
      throw err
    }),
  }
}

/** 内存 mock 持久化（收集 events，便于断言）。 */
function makeMemoryPersistence() {
  const eventLog: AgentAction[] = []
  const writeTurn = vi.fn(async (_world: WorldState, _phase: string, events: AgentAction[] = []) => {
    for (const e of events) eventLog.push(structuredClone(e))
  })
  return {
    persistence: {
      writeWorldState: vi.fn(), readWorldState: vi.fn(), listSaves: vi.fn(),
      createSave: vi.fn(), deleteSave: vi.fn(), writeTurn, readManifest: vi.fn(),
    },
    eventLog,
  }
}

/**
 * 跑一回合完整 M3 编排，返回收集的 event-log。
 *
 * planning → handshake → submit（attack）→ lock → advanceTurn（4 批次编排 → persist）。
 */
async function runOneTurn(directorRole: DirectorRole): Promise<AgentAction[]> {
  let ctx = createInitialContext(makeWorld())
  ctx.game.phase = 'planning'
  ctx = enterHandshake(ctx)
  ctx = submitOrder(ctx, buildEnvelope({
    turn: 0, faction: 'blue', agentId: 'chief-blue', intent: 'attack',
    payload: { unitId: 'blue-1', targetUnitId: 'red-1' }, sequence: 0,
  }))
  ctx = lockOrders(ctx)
  expect(ctx.game.phase).toBe('locked')

  const deps: MultiAgentResolverDeps = {
    llmService: createLlmService(),
    workerService: makeDeterministicPhysics(),
    theaterRole: makeMockTheater(),
    commanderRole: makeMockCommander(),
    directorRole,
  }
  const { persistence, eventLog } = makeMemoryPersistence()
  const services: TurnOrchestratorServices = {
    persistence,
    resolve: createMultiAgentResolver(deps),
  }
  const result = await advanceTurn(ctx, services)
  expect(result.context.game.phase).toBe('idle')
  expect(result.context.game.world.turnIndex).toBe(1)
  return eventLog
}

// ============================================================================
// 测试用例
// ============================================================================

describe('M3 端到端确定性（验收#7 物理层哈希门 + degraded 路径）', () => {
  it('相同 seed 两次完整回合：物理层哈希一致，director 产物一致（mock 固定）', async () => {
    const log1 = await runOneTurn(makeFixedDirector())
    const log2 = await runOneTurn(makeFixedDirector())

    // 物理层哈希一致（确定性两层之物理层，可重算可复现）
    const h1 = physicsEventsHash(log1)
    const h2 = physicsEventsHash(log2)
    expect(h1).toBe(h2)
    // 物理层应至少有一条 engagement 事件
    expect(log1.filter((e) => e.source === 'physics').length).toBeGreaterThan(0)

    // director 战报两次完全一致（mock 固定）
    const report1 = log1.find((e) => e.source === 'director' && e.kind === 'report')
    const report2 = log2.find((e) => e.source === 'director' && e.kind === 'report')
    expect(report1).toBeDefined()
    expect(report2).toBeDefined()
    expect(report1!.text).toBe(report2!.text)
    expect(report1!.text).toContain('固定 mock 战报')

    // 哈希非空（证明有内容可比对）
    expect(h1).not.toBe(hashString(''))
  })

  it('degraded 路径：LLM 抛 timeout → 规则引擎兜底 → source:rule-engine 入 log', async () => {
    const log = await runOneTurn(makeTimeoutDirector())

    // 兜底事件含 source:rule-engine（回放采信）
    expect(log.some((e) => e.source === 'rule-engine')).toBe(true)

    // 规则引擎兜底把物理结果包装为 source:rule-engine（区别于 director 真路径的 source:physics），
    // 物理结算数据仍在（payload.data 含 engagement 数值），只是来源标记为降级。
    const reEngagement = log.find(
      (e) => e.source === 'rule-engine' && e.payload['kind'] === 'engagement',
    )
    expect(reEngagement, '应含 rule-engine 包装的物理交火数据').toBeDefined()

    // rule-engine 产物含「[规则引擎]」明示前缀（TDD §1.5 UI 明示降级结算）
    const reEvents = log.filter((e) => e.source === 'rule-engine')
    const reNotice = reEvents.find((e) => e.text && e.text.includes('[规则引擎]'))
    expect(reNotice, '应含 [规则引擎] 降级明示').toBeDefined()
  })

  it('完整 M3 阶段链：planning→handshake→locked→resolution→briefing→persist→idle', async () => {
    // 这条用例已由 runOneTurn 内部 advanceTurn 覆盖（断言 phase=idle, turnIndex=1），
    // 此处显式再次断言完整链路走通（非 degraded 路径 director 真产出 source:director）。
    const log = await runOneTurn(makeFixedDirector())

    // 完整链路走完：含 physics（resolution）+ director（briefing 战报）
    expect(log.some((e) => e.source === 'physics')).toBe(true)
    expect(log.some((e) => e.source === 'director')).toBe(true)
    // 持久化已发生（落盘 await 非空）
    expect(log.length).toBeGreaterThan(0)
  })
})

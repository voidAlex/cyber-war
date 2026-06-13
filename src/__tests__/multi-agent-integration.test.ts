/**
 * M3 多 Agent 编排接线集成测试（multi-agent-integration.test.ts）。
 *
 * 验证 createMultiAgentResolver 接入 advanceTurn 的完整闭环：
 * - locked → resolution（orchestrateTurnResolution）→ briefing → persist → idle → NEXT_TURN。
 * - 事件落 event-log，按 source 分源标记（physics/director/rule-engine）。
 * - 导演部 LLM 失败 → 自动切规则引擎兜底，闭环不中断（degraded 反映到 resolution）。
 *
 * 用 mock PhysicsEngineClient + mock 角色（不拉起真实 Worker/LLM）。
 *
 * @module __tests__/multi-agent-integration
 */

import { describe, it, expect, vi } from 'vitest'
import { advanceTurn, createMultiAgentResolver } from '@/layers/application/orchestrator/turn-orchestrator'
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
import type { TheaterRole, CommanderRole, DirectorRole, DirectorAdjudicateParams } from '@/layers/agents/roles'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import type { WorldState, Unit, MapCell, AgentAction } from '@/types'

function makeWorld(): WorldState {
  const cells: MapCell[] = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      cells.push({ id: `${col}:${row}`, col, row, terrain: 'plain', movementCost: 1, defenseBonus: 0, isObjective: false })
    }
  }
  const units: Unit[] = [
    { id: 'u1', factionId: 'blue', type: 'armor', coord: { col: 0, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
    { id: 'e1', factionId: 'red', type: 'infantry', coord: { col: 3, row: 3 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
  ]
  return {
    saveId: 's', scenarioId: 'sc', scenarioSeed: 'sc:s', turnIndex: 0, inGameDate: 'D-0',
    factions: [
      { id: 'blue', name: '蓝', color: '#00F', side: 'player', commander: { id: 'cb', name: 'cb', personality: '', aggression: 0.5, obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [] },
      { id: 'red', name: '红', color: '#F00', side: 'enemy', commander: { id: 'cr', name: 'cr', personality: '', aggression: 0.7, obedience: 0.6, preferredTempo: 'rapid', doctrineTags: [] }, theaterCommanders: [], supply: { supplies: 70, ammunition: 70, fuel: 70 }, trust: {}, doctrineTags: [] },
    ],
    units,
    map: { gridType: 'square', cols: 4, rows: 4, cells, highValueNodes: [{ id: 'fort', name: '堡垒', cellId: '2:2', controlThreshold: 1 }] },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [], lockedOrders: {}, lastResolution: null, contextSummaries: {},
  }
}

function makeMockWorker(result: ResolutionResult): PhysicsEngineClient {
  return { simulateTurn: vi.fn(async () => result), init: vi.fn(), destroy: vi.fn() } as unknown as PhysicsEngineClient
}

function makeMockTheater(): TheaterRole {
  return {
    resolve: vi.fn(async () => ({
      actions: [{ unitId: 'u1', intent: 'move' as const, targetCoord: { col: 2, row: 2 }, sequence: 1000, seed: 'sc:s:0:1000' }],
    })),
  }
}

function makeMockCommander(): CommanderRole {
  return {
    resolve: vi.fn(async () => ({
      decisions: [{ unitId: 'e1', intent: 'attack' as const, targetUnitId: 'u1', rationale: 'aggression 高', sequence: 2000, seed: 'sc:s:0:2000' }],
      disobeying: false,
    })),
  }
}

function makeMemoryPersistence() {
  const eventLog: AgentAction[] = []
  const writeTurn = vi.fn(async (_world: WorldState, _phase: string, events: AgentAction[] = []) => {
    for (const e of events) eventLog.push(e)
  })
  return {
    persistence: {
      writeWorldState: vi.fn(), readWorldState: vi.fn(), listSaves: vi.fn(), createSave: vi.fn(), deleteSave: vi.fn(), writeTurn, readManifest: vi.fn(),
    },
    eventLog,
  }
}

describe('createMultiAgentResolver 接入 advanceTurn — 完整闭环', () => {
  it('locked → resolution（4 批次）→ briefing → persist → idle → NEXT_TURN', async () => {
    let ctx = createInitialContext(makeWorld())
    ctx.game.phase = 'planning'
    ctx = enterHandshake(ctx)
    ctx = submitOrder(ctx, buildEnvelope({ turn: 0, faction: 'blue', intent: 'move', payload: { unitId: 'u1', target: { col: 2, row: 2 } }, sequence: 0 }))
    ctx = lockOrders(ctx)

    const evt: ResolutionEvent = {
      id: 'evt:0:movement:0', source: 'physics', turn: 0, sequence: 0, kind: 'movement',
      description: 'u1 机动至 (2,2)', data: { unitId: 'u1' },
    }
    const physics: ResolutionResult = { turn: 0, events: [evt], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }

    const deps: MultiAgentResolverDeps = {
      llmService: createLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheater(),
      commanderRole: makeMockCommander(),
      directorRole: {
        adjudicate: vi.fn(async (p: DirectorAdjudicateParams) => ({
          finalResult: p.physicsResult,
          resolutionSummary: { turn: p.turn, casualties: {}, objectiveChanges: [], reportText: '战报', degraded: false },
          directorEvents: p.physicsResult.events.map((e) => ({ id: e.id, turn: p.turn, agentId: 'd', agentRole: 'director' as const, kind: 'adjudication' as const, source: 'physics' as const, payload: {}, text: e.description, sequence: e.sequence, seed: `${p.scenarioSeed}:${p.turn}:${e.sequence}` })),
          appliedOverrides: [], keyEvents: [],
        })),
      },
    }

    const { persistence, eventLog } = makeMemoryPersistence()
    const services: TurnOrchestratorServices = { persistence, resolve: createMultiAgentResolver(deps) }

    const result = await advanceTurn(ctx, services)
    expect(result.context.game.phase).toBe('idle')
    expect(result.context.game.world.turnIndex).toBe(1)
    // 事件落盘（source:physics）
    expect(eventLog.length).toBeGreaterThan(0)
    expect(eventLog.some((e) => e.source === 'physics')).toBe(true)
  })

  it('导演部异常 → 规则引擎兜底，闭环不中断，事件含 source:rule-engine', async () => {
    let ctx = createInitialContext(makeWorld())
    ctx.game.phase = 'planning'
    ctx = enterHandshake(ctx)
    ctx = submitOrder(ctx, buildEnvelope({ turn: 0, faction: 'blue', intent: 'move', payload: { unitId: 'u1', target: { col: 2, row: 2 } }, sequence: 0 }))
    ctx = lockOrders(ctx)

    const evt: ResolutionEvent = {
      id: 'evt:0:movement:0', source: 'physics', turn: 0, sequence: 0, kind: 'movement',
      description: 'u1 机动', data: { unitId: 'u1' },
    }
    const physics: ResolutionResult = { turn: 0, events: [evt], stateChanges: { unitUpdates: {}, annihilated: [], objectiveChanges: [] }, success: true }

    // 导演部抛错（编排层兜底切规则引擎）
    const failingDirector: DirectorRole = { adjudicate: vi.fn(async () => { throw new Error('LLM 雪崩') }) }
    const deps: MultiAgentResolverDeps = {
      llmService: createLlmService(),
      workerService: makeMockWorker(physics),
      theaterRole: makeMockTheater(),
      commanderRole: makeMockCommander(),
      directorRole: failingDirector,
    }
    const { persistence, eventLog } = makeMemoryPersistence()
    const services: TurnOrchestratorServices = { persistence, resolve: createMultiAgentResolver(deps) }

    const result = await advanceTurn(ctx, services)
    // 闭环仍完成（降级不阻塞游戏）
    expect(result.context.game.phase).toBe('idle')
    expect(result.context.game.world.turnIndex).toBe(1)
    // 兜底事件含 source:rule-engine
    expect(eventLog.some((e) => e.source === 'rule-engine')).toBe(true)
  })
})

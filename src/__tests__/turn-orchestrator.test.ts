/**
 * turn-orchestrator 集成测试（turn-orchestrator.test.ts）。
 *
 * 验证：
 * - advanceTurn 在 mock persistence 下调用 writeTurn（验证落盘 await、非 fire-and-forget）。
 * - 推进完成后 turnIndex 自增、phase 回 idle。
 * - 落盘失败时抛 TURN_PERSIST_FAILED 且不推进（persist-gate 守恒）。
 * - AbortController 取消时抛 TURN_CANCELLED。
 * - 刷新恢复链路：writeTurn 写入的 world-state turnIndex 可被 readWorldState 读回。
 *
 * @module __tests__/turn-orchestrator
 */

import { describe, it, expect, vi } from 'vitest'
import {
  advanceTurn,
  TURN_PERSIST_FAILED,
  TURN_CANCELLED,
} from '@/layers/application/orchestrator/turn-orchestrator'
import type { TurnOrchestratorServices } from '@/layers/application/orchestrator/turn-orchestrator'
import { createInitialContext } from '@/layers/application/state-machine/reducer'
import type { WorldState, AgentAction } from '@/types'
import { makeWorld } from './test-helpers'

/**
 * 内存 mock 持久化服务（模拟 gateway 落盘 + 读回）。
 */
function makeMemoryPersistence() {
  const store = new Map<string, WorldState>()
  const eventLog: AgentAction[] = []
  const writeTurn = vi.fn(async (world: WorldState, _phase: string, events: AgentAction[] = []) => {
    // 模拟 gateway 原子写 + 追加事件
    store.set(world.saveId, structuredClone(world))
    for (const e of events) eventLog.push(e)
  })
  return {
    persistence: {
      writeWorldState: vi.fn(async (saveId: string, world: WorldState) => {
        store.set(saveId, structuredClone(world))
      }),
      readWorldState: vi.fn(async (saveId: string) => store.get(saveId) ?? null),
      listSaves: vi.fn(async () => Array.from(store.keys())),
      createSave: vi.fn(),
      deleteSave: vi.fn(),
      writeTurn,
      readManifest: vi.fn(async () => null),
    },
    store,
    eventLog,
  }
}

describe('advanceTurn — 空转闭环集成', () => {
  it('从 planning 推进到下一回合 idle，turnIndex 0→1，落盘被调用', async () => {
    const { persistence } = makeMemoryPersistence()
    const services: TurnOrchestratorServices = { persistence }
    const ctx = createInitialContext(makeWorld())
    // 进入 planning（模拟 UI 点了「开始规划」）
    ctx.game.phase = 'planning'

    const result = await advanceTurn(ctx, services)

    expect(result.context.game.phase).toBe('idle')
    expect(result.context.game.world.turnIndex).toBe(1)
    // 关键：落盘被 await 调用过（非 fire-and-forget）
    expect(persistence.writeTurn).toHaveBeenCalledTimes(1)
    // 落盘写入的 world.turnIndex 应为 1（下一回合 idle 态，刷新恢复正确回合）。
    // 内存上下文 turnIndex 也是 1（NEXT_TURN 后），两者一致；落盘语义见 advanceTurn 注释。
    const writtenWorld = persistence.writeTurn.mock.calls[0][0] as WorldState
    expect(writtenWorld.turnIndex).toBe(1)
  })

  it('从 idle 自动 START_TURN 再推进', async () => {
    const { persistence } = makeMemoryPersistence()
    const ctx = createInitialContext(makeWorld())
    // 直接从 idle 起，advanceTurn 内部应先 START_TURN
    const result = await advanceTurn(ctx, { persistence })
    expect(result.context.game.world.turnIndex).toBe(1)
    expect(persistence.writeTurn).toHaveBeenCalledTimes(1)
  })

  it('连续空转 3 回合，turnIndex 0→3，每次都落盘', async () => {
    const { persistence } = makeMemoryPersistence()
    let ctx = createInitialContext(makeWorld())
    for (let i = 1; i <= 3; i++) {
      ctx = (await advanceTurn(ctx, { persistence })).context
      expect(ctx.game.world.turnIndex).toBe(i)
      expect(ctx.game.phase).toBe('idle')
    }
    expect(persistence.writeTurn).toHaveBeenCalledTimes(3)
  })

  it('自定义 resolve 服务产出的事件被追加落盘', async () => {
    const { persistence, eventLog } = makeMemoryPersistence()
    const fakeEvent: AgentAction = {
      id: 'evt-1',
      turn: 0,
      agentId: 'director-1',
      agentRole: 'director',
      kind: 'report',
      source: 'rule-engine',
      payload: { foo: 'bar' },
      sequence: 3001,
      seed: 's:0:3001',
    }
    const services: TurnOrchestratorServices = {
      persistence,
      resolve: async () => ({
        resolution: {
          turn: 0,
          casualties: {},
          objectiveChanges: [],
          reportText: '',
          degraded: false,
        },
        events: [fakeEvent],
      }),
    }
    const ctx = createInitialContext(makeWorld())
    ctx.game.phase = 'planning'

    await advanceTurn(ctx, services)
    expect(eventLog).toHaveLength(1)
    expect(eventLog[0]).toEqual(fakeEvent)
  })
})

describe('advanceTurn — 落盘失败守恒', () => {
  it('writeTurn 抛错时回退到 briefing 且不推进 turnIndex（抛 TURN_PERSIST_FAILED）', async () => {
    const failingPersistence = {
      writeTurn: vi.fn(async () => {
        throw new Error('disk full')
      }),
      writeWorldState: vi.fn(),
      readWorldState: vi.fn(),
      listSaves: vi.fn(),
      createSave: vi.fn(),
      deleteSave: vi.fn(),
      readManifest: vi.fn(),
    }
    const ctx = createInitialContext(makeWorld())
    ctx.game.phase = 'planning'

    await expect(advanceTurn(ctx, { persistence: failingPersistence })).rejects.toMatchObject({
      code: TURN_PERSIST_FAILED,
    })

    // 抛出的错误附带回退后的上下文：phase 应为 briefing（persist→briefing 失败回路）
    try {
      await advanceTurn(ctx, { persistence: failingPersistence })
    } catch (err) {
      const e = err as { context?: { game: { phase: string } }; code?: string }
      expect(e.code).toBe(TURN_PERSIST_FAILED)
      expect(e.context?.game.phase).toBe('briefing')
    }
  })
})

describe('advanceTurn — AbortController 取消', () => {
  it('预先 abort 时抛 TURN_CANCELLED', async () => {
    const { persistence } = makeMemoryPersistence()
    const ctx = createInitialContext(makeWorld())
    ctx.game.phase = 'planning'
    const ac = new AbortController()
    ac.abort()
    await expect(advanceTurn(ctx, { persistence }, ac.signal)).rejects.toMatchObject({
      code: TURN_CANCELLED,
    })
  })
})

describe('advanceTurn — 刷新恢复链路', () => {
  it('writeTurn 写入的 world-state 可被 readWorldState 读回（模拟重启恢复）', async () => {
    const { persistence, store } = makeMemoryPersistence()
    const ctx = createInitialContext(makeWorld({ saveId: 'save-A' }))
    ctx.game.phase = 'planning'

    // 推进 3 回合（每回合 writeTurn 落盘）
    let cur = ctx
    for (let i = 0; i < 3; i++) {
      cur = (await advanceTurn(cur, { persistence })).context
    }
    expect(cur.game.world.turnIndex).toBe(3)

    // 模拟「重启」：从 store 读回最后一次落盘的 world-state
    // 落盘语义：writeTurn 落盘下一回合 idle 态（turnIndex=N+1），
    // 故第 3 回合（推进到内存 turnIndex=3）落盘时 world.turnIndex=3（刷新恢复显示正确回合）。
    const persisted = store.get('save-A')
    expect(persisted).toBeDefined()
    expect(persisted!.turnIndex).toBe(3) // 第 3 回合落盘 turnIndex=3（下一回合 idle 态，与内存一致）

    // readWorldState 读回后，可重建 idle 上下文（与 store.loadSave 一致）
    const restored = await persistence.readWorldState('save-A')
    expect(restored).not.toBeNull()
    expect(restored!.saveId).toBe('save-A')
    expect(restored!.scenarioId).toBe('test-scenario')
  })
})

/**
 * reducer 纯函数测试（reducer.test.ts）。
 *
 * 覆盖：
 * - 每个合法转换推进正确。
 * - 非法转换被守卫拒绝（返回 error，state 引用不变）。
 * - NEXT_TURN 受 persistCompleted 守卫（persist-gate 回归）。
 * - 失败回路 resolution→locked / persist→briefing。
 *
 * 借鉴 src-legacy/game/state-machine.test.ts 风格，但针对新守卫。
 *
 * @module __tests__/reducer
 */

import { describe, it, expect } from 'vitest'
import { wegoReducer, createInitialContext } from '@/layers/application/state-machine/reducer'
import { makeContextAtPhase, makeWorld } from './test-helpers'
import type { ResolutionSummary } from '@/types'

describe('wegoReducer — 合法主链路转换', () => {
  it('START_TURN: idle → planning', () => {
    const ctx = makeContextAtPhase('idle')
    const r = wegoReducer(ctx, { type: 'START_TURN' })
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()
    expect(r.state.game.phase).toBe('planning')
    expect(r.state.persistCompleted).toBe(false)
  })

  it('ENTER_HANDSHAKE: planning → handshake', () => {
    const ctx = makeContextAtPhase('planning')
    const r = wegoReducer(ctx, { type: 'ENTER_HANDSHAKE' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('handshake')
  })

  it('CONFIRM_HANDSHAKE: handshake → locked', () => {
    const ctx = makeContextAtPhase('handshake')
    const r = wegoReducer(ctx, { type: 'CONFIRM_HANDSHAKE' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('locked')
  })

  it('LOCK_ORDERS: handshake → locked（与 CONFIRM_HANDSHAKE 等价）', () => {
    const ctx = makeContextAtPhase('handshake')
    const r = wegoReducer(ctx, { type: 'LOCK_ORDERS' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('locked')
  })

  it('ENTER_RESOLUTION: locked → resolution', () => {
    const ctx = makeContextAtPhase('locked')
    const r = wegoReducer(ctx, { type: 'ENTER_RESOLUTION' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('resolution')
  })

  it('FINISH_RESOLUTION: resolution → briefing（写入 lastResolution）', () => {
    const ctx = makeContextAtPhase('resolution')
    const resolution: ResolutionSummary = {
      turn: 0,
      casualties: {},
      objectiveChanges: [],
      reportText: '',
      degraded: false,
    }
    const r = wegoReducer(ctx, { type: 'FINISH_RESOLUTION', resolution })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('briefing')
    expect(r.state.lastResolution).toBe(resolution)
  })

  it('ENTER_PERSIST: briefing → persist（标记 persisting）', () => {
    const ctx = makeContextAtPhase('briefing')
    const r = wegoReducer(ctx, { type: 'ENTER_PERSIST' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('persist')
    expect(r.state.persisting).toBe(true)
    expect(r.state.persistCompleted).toBe(false)
  })

  // 第 3 批：战术决策 OFFER_DECISION / RESOLVE_DECISION
  it('OFFER_DECISION: briefing → decision（存 pendingDecision）', () => {
    const ctx = makeContextAtPhase('briefing')
    const decision = {
      id: 'd1',
      turn: 3,
      label: '兵力集中',
      description: '请选择',
      options: [
        {
          id: 'opt-a',
          label: 'A',
          description: 'A',
          overrides: [
            {
              field: 'units.u1.strength',
              before: 80,
              after: 95,
              reason: '提升',
            },
          ],
        },
      ],
    }
    const r = wegoReducer(ctx, { type: 'OFFER_DECISION', decision })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('decision')
    expect(r.state.pendingDecision).toEqual(decision)
  })

  it('RESOLVE_DECISION: decision → persist（应用 overrides 到 world）', () => {
    // 构造 decision 阶段 ctx + 含可被覆写单位的 world
    const world = makeWorld()
    world.units = [
      {
        id: 'u1',
        factionId: 'blue',
        type: 'infantry',
        coord: { col: 0, row: 0 },
        strength: 80,
        personnel: 1000,
        maxPersonnel: 1000,
        fuel: 80,
        ammo: 80,
        morale: 60,
        fatigue: 10,
        detection: {},
        orders: [],
        status: [],
      },
    ]
    const ctx = makeContextAtPhase('decision')
    ctx.game.world = world
    ctx.pendingDecision = {
      id: 'd1',
      turn: 3,
      label: 'l',
      description: 'd',
      options: [],
    }
    const r = wegoReducer(ctx, {
      type: 'RESOLVE_DECISION',
      optionId: 'opt-a',
      overrides: [
        { field: 'units.u1.strength', before: 80, after: 95, reason: '提升' },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('persist')
    expect(r.state.pendingDecision).toBeNull()
    // overrides 已应用到 world.units
    const updatedUnit = r.state.game.world.units.find((u) => u.id === 'u1')
    expect(updatedUnit?.strength).toBe(95)
  })

  it('RESOLVE_DECISION 跳过（optionId=null, 空 overrides）: world 不变', () => {
    const ctx = makeContextAtPhase('decision')
    ctx.pendingDecision = {
      id: 'd1',
      turn: 3,
      label: 'l',
      description: 'd',
      options: [],
    }
    const originalWorld = ctx.game.world
    const r = wegoReducer(ctx, {
      type: 'RESOLVE_DECISION',
      optionId: null,
      overrides: [],
    })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('persist')
    expect(r.state.pendingDecision).toBeNull()
    // 无 overrides → world 引用不变（性能优化）
    expect(r.state.game.world).toBe(originalWorld)
  })

  it('PERSIST_COMPLETE: persist → idle（放行 NEXT_TURN）', () => {
    const ctx = makeContextAtPhase('persist')
    const r = wegoReducer(ctx, { type: 'PERSIST_COMPLETE' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('idle')
    expect(r.state.persisting).toBe(false)
    expect(r.state.persistCompleted).toBe(true)
  })

  it('NEXT_TURN: idle → idle 且 turnIndex+1（persistCompleted 已满足）', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = true
    expect(ctx.game.world.turnIndex).toBe(0)
    const r = wegoReducer(ctx, { type: 'NEXT_TURN' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('idle')
    expect(r.state.game.world.turnIndex).toBe(1)
  })
})

describe('wegoReducer — 完整空转闭环（连续 dispatch）', () => {
  it('从 idle 空转到下一回合 idle（turnIndex 0→1）', () => {
    let ctx = createInitialContext(makeWorld())
    expect(ctx.game.phase).toBe('idle')

    ctx = wegoReducer(ctx, { type: 'START_TURN' }).state
    ctx = wegoReducer(ctx, { type: 'ENTER_HANDSHAKE' }).state
    ctx = wegoReducer(ctx, { type: 'CONFIRM_HANDSHAKE' }).state
    ctx = wegoReducer(ctx, { type: 'ENTER_RESOLUTION' }).state
    ctx = wegoReducer(ctx, {
      type: 'FINISH_RESOLUTION',
      resolution: { turn: 0, casualties: {}, objectiveChanges: [], reportText: '', degraded: false },
    }).state
    ctx = wegoReducer(ctx, { type: 'ENTER_PERSIST' }).state
    ctx = wegoReducer(ctx, { type: 'PERSIST_COMPLETE' }).state
    ctx = wegoReducer(ctx, { type: 'NEXT_TURN' }).state

    expect(ctx.game.phase).toBe('idle')
    expect(ctx.game.world.turnIndex).toBe(1)
  })
})

describe('wegoReducer — 非法转换被守卫拒绝', () => {
  it('START_TURN 在非 idle 阶段被拒', () => {
    const ctx = makeContextAtPhase('planning')
    const r = wegoReducer(ctx, { type: 'START_TURN' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('planning')
    expect(r.state).toBe(ctx) // 引用不变
  })

  it('ENTER_RESOLUTION 在非 locked 阶段被拒', () => {
    const ctx = makeContextAtPhase('handshake')
    const r = wegoReducer(ctx, { type: 'ENTER_RESOLUTION' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('handshake')
    expect(r.state).toBe(ctx)
  })

  it('LOCK_ORDERS 在 planning 阶段被拒', () => {
    const ctx = makeContextAtPhase('planning')
    const r = wegoReducer(ctx, { type: 'LOCK_ORDERS' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('planning')
    expect(r.state).toBe(ctx)
  })

  it('PERSIST_COMPLETE 在非 persist 阶段被拒', () => {
    const ctx = makeContextAtPhase('briefing')
    const r = wegoReducer(ctx, { type: 'PERSIST_COMPLETE' })
    expect(r.ok).toBe(false)
    expect(r.state).toBe(ctx)
  })

  it('ENTER_HANDSHAKE 在 idle 被拒', () => {
    const ctx = makeContextAtPhase('idle')
    const r = wegoReducer(ctx, { type: 'ENTER_HANDSHAKE' })
    expect(r.ok).toBe(false)
    expect(r.state).toBe(ctx)
  })
})

describe('wegoReducer — persist-gate 回归', () => {
  it('NEXT_TURN 在 persistCompleted=false 时被拒（即使 phase=idle）', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = false // 关键：未完成持久化
    const r = wegoReducer(ctx, { type: 'NEXT_TURN' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('持久化未完成')
    expect(r.state).toBe(ctx)
    expect(ctx.game.world.turnIndex).toBe(0) // 未推进
  })

  it('NEXT_TURN 在 persistCompleted=true 但 phase=planning 时被拒', () => {
    const ctx = makeContextAtPhase('planning')
    ctx.persistCompleted = true
    const r = wegoReducer(ctx, { type: 'NEXT_TURN' })
    expect(r.ok).toBe(false)
    expect(r.state).toBe(ctx)
  })
})

describe('wegoReducer — 失败回路', () => {
  it('RESOLUTION_FAILED: resolution → locked', () => {
    const ctx = makeContextAtPhase('resolution')
    const r = wegoReducer(ctx, { type: 'RESOLUTION_FAILED', reason: '物理引擎异常' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('locked')
    expect(r.state.error).toBe('物理引擎异常')
  })

  it('PERSIST_FAILED: persist → briefing', () => {
    const ctx = makeContextAtPhase('persist')
    const r = wegoReducer(ctx, { type: 'PERSIST_FAILED', reason: '写盘失败' })
    expect(r.ok).toBe(true)
    expect(r.state.game.phase).toBe('briefing')
    expect(r.state.persisting).toBe(false)
    expect(r.state.persistCompleted).toBe(false)
    expect(r.state.error).toBe('写盘失败')
  })

  it('RESOLUTION_FAILED 在非 resolution 阶段被拒', () => {
    const ctx = makeContextAtPhase('idle')
    const r = wegoReducer(ctx, { type: 'RESOLUTION_FAILED', reason: 'x' })
    expect(r.ok).toBe(false)
    expect(r.state).toBe(ctx)
  })
})

describe('wegoReducer — 命令链路守卫', () => {
  it('SUBMIT_ORDER 在 planning 阶段允许', () => {
    const ctx = makeContextAtPhase('planning')
    const envelope = {
      turn: 0,
      faction: 'f1',
      agentId: 'a1',
      agentRole: 'chief' as const,
      intent: '前进',
      payload: {},
      confidence: 0.9,
      requiresConfirmation: false,
      sequence: 1,
      state: 'pending' as const,
    }
    const r = wegoReducer(ctx, { type: 'SUBMIT_ORDER', envelope })
    expect(r.ok).toBe(true)
    expect(r.state.pendingOrders).toHaveLength(1)
  })

  it('SUBMIT_ORDER 在 idle 阶段被拒', () => {
    const ctx = makeContextAtPhase('idle')
    const envelope = {
      turn: 0,
      faction: 'f1',
      agentId: 'a1',
      agentRole: 'chief' as const,
      intent: '前进',
      payload: {},
      confidence: 0.9,
      requiresConfirmation: false,
      sequence: 1,
      state: 'pending' as const,
    }
    const r = wegoReducer(ctx, { type: 'SUBMIT_ORDER', envelope })
    expect(r.ok).toBe(false)
    expect(r.state).toBe(ctx)
  })
})

describe('wegoReducer — LOAD_CONTEXT 恢复', () => {
  it('LOAD_CONTEXT 直接替换整个上下文', () => {
    const ctx = makeContextAtPhase('idle')
    const restored = makeContextAtPhase('briefing')
    restored.game.world = makeWorld({ turnIndex: 5 })
    const r = wegoReducer(ctx, { type: 'LOAD_CONTEXT', context: restored })
    expect(r.ok).toBe(true)
    expect(r.state).toBe(restored)
    expect(r.state.game.world.turnIndex).toBe(5)
  })
})

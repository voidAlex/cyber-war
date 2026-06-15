/**
 * guard 守卫测试（guard.test.ts）。
 *
 * 覆盖 canSubmitOrder / canConfirmHandshake / canLockOrders / canAdvanceTurn /
 * guardAction / isActionAllowed / isValidTransition。
 *
 * @module __tests__/guard
 */

import { describe, it, expect } from 'vitest'
import {
  canSubmitOrder,
  canConfirmHandshake,
  canLockOrders,
  canAdvanceTurn,
  guardAction,
  isActionAllowed,
} from '@/layers/application/state-machine/guard'
import { isValidTransition, VALID_TRANSITIONS } from '@/layers/application/state-machine/transitions'
import { makeContext, makeContextAtPhase } from './test-helpers'
import type { TacticalDecision } from '@/types'

describe('canSubmitOrder', () => {
  it('planning/handshake 允许', () => {
    expect(canSubmitOrder('planning')).toBe(true)
    expect(canSubmitOrder('handshake')).toBe(true)
  })
  it('其他阶段拒绝', () => {
    expect(canSubmitOrder('idle')).toBe(false)
    expect(canSubmitOrder('locked')).toBe(false)
    expect(canSubmitOrder('resolution')).toBe(false)
    expect(canSubmitOrder('briefing')).toBe(false)
    expect(canSubmitOrder('persist')).toBe(false)
  })
})

describe('canConfirmHandshake / canLockOrders', () => {
  it('仅 handshake 允许', () => {
    expect(canConfirmHandshake('handshake')).toBe(true)
    expect(canLockOrders('handshake')).toBe(true)
    expect(canConfirmHandshake('planning')).toBe(false)
    expect(canLockOrders('locked')).toBe(false)
  })
})

describe('canAdvanceTurn（persist-gate）', () => {
  it('idle + persistCompleted 允许', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = true
    expect(canAdvanceTurn(ctx)).toBe(true)
  })
  it('persistCompleted=false 时拒绝（即使 idle）', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = false
    expect(canAdvanceTurn(ctx)).toBe(false)
  })
  it('非 idle 阶段拒绝（即使 persistCompleted=true）', () => {
    const ctx = makeContextAtPhase('planning')
    ctx.persistCompleted = true
    expect(canAdvanceTurn(ctx)).toBe(false)
  })
})

describe('guardAction', () => {
  it('START_TURN 在 idle 放行', () => {
    const ctx = makeContextAtPhase('idle')
    expect(guardAction(ctx, { type: 'START_TURN' })).toBeNull()
  })
  it('NEXT_TURN 未持久化时返回拒绝原因', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = false
    const reason = guardAction(ctx, { type: 'NEXT_TURN' })
    expect(reason).not.toBeNull()
    expect(reason).toContain('持久化未完成')
  })
  it('LOCK_ORDERS 在 idle 拒绝', () => {
    const ctx = makeContextAtPhase('idle')
    expect(guardAction(ctx, { type: 'LOCK_ORDERS' })).not.toBeNull()
  })
  it('RETRY 任何阶段放行', () => {
    for (const phase of ['idle', 'planning', 'persist'] as const) {
      expect(guardAction(makeContextAtPhase(phase), { type: 'RETRY', reason: 'r' })).toBeNull()
    }
  })
  // 第 3 批：战术决策守卫
  it('OFFER_DECISION 仅 briefing 放行', () => {
    const decision: TacticalDecision = {
      id: 'test-decision',
      turn: 0,
      label: '测试决策',
      description: '测试',
      options: [
        {
          id: 'opt-a',
          label: 'A',
          description: 'A',
          overrides: [],
        },
      ],
    }
    expect(guardAction(makeContextAtPhase('briefing'), { type: 'OFFER_DECISION', decision })).toBeNull()
    expect(
      guardAction(makeContextAtPhase('idle'), { type: 'OFFER_DECISION', decision }),
    ).not.toBeNull()
    expect(
      guardAction(makeContextAtPhase('decision'), { type: 'OFFER_DECISION', decision }),
    ).not.toBeNull()
  })
  it('RESOLVE_DECISION 仅 decision 放行', () => {
    expect(
      guardAction(makeContextAtPhase('decision'), {
        type: 'RESOLVE_DECISION',
        optionId: null,
        overrides: [],
      }),
    ).toBeNull()
    expect(
      guardAction(makeContextAtPhase('briefing'), {
        type: 'RESOLVE_DECISION',
        optionId: null,
        overrides: [],
      }),
    ).not.toBeNull()
    expect(
      guardAction(makeContextAtPhase('persist'), {
        type: 'RESOLVE_DECISION',
        optionId: null,
        overrides: [],
      }),
    ).not.toBeNull()
  })
})

describe('isActionAllowed（基于 phase 的便捷守卫）', () => {
  it('START_TURN 仅 idle 允许', () => {
    expect(isActionAllowed('idle', 'START_TURN')).toBe(true)
    expect(isActionAllowed('planning', 'START_TURN')).toBe(false)
  })
  it('LOCK_ORDERS 仅 handshake 允许', () => {
    expect(isActionAllowed('handshake', 'LOCK_ORDERS')).toBe(true)
    expect(isActionAllowed('planning', 'LOCK_ORDERS')).toBe(false)
  })
})

describe('isValidTransition / VALID_TRANSITIONS', () => {
  it('主链路合法迁移', () => {
    expect(isValidTransition('idle', 'planning')).toBe(true)
    expect(isValidTransition('planning', 'handshake')).toBe(true)
    expect(isValidTransition('handshake', 'locked')).toBe(true)
    expect(isValidTransition('locked', 'resolution')).toBe(true)
    expect(isValidTransition('resolution', 'briefing')).toBe(true)
    expect(isValidTransition('briefing', 'persist')).toBe(true)
    expect(isValidTransition('persist', 'idle')).toBe(true)
  })
  it('失败回路合法', () => {
    expect(isValidTransition('resolution', 'locked')).toBe(true)
    expect(isValidTransition('persist', 'briefing')).toBe(true)
  })
  it('非法迁移拒绝', () => {
    expect(isValidTransition('idle', 'locked')).toBe(false)
    expect(isValidTransition('planning', 'resolution')).toBe(false)
    expect(isValidTransition('locked', 'idle')).toBe(false)
  })
  it('VALID_TRANSITIONS 表覆盖全部 8 阶段（含第 3 批 decision）', () => {
    const phases = Object.keys(VALID_TRANSITIONS)
    expect(phases).toHaveLength(8)
    expect(phases.sort()).toEqual(
      [
        'briefing',
        'decision',
        'handshake',
        'idle',
        'locked',
        'persist',
        'planning',
        'resolution',
      ],
    )
  })
  // 第 3 批：战术决策转换链
  it('briefing → decision → persist 合法（第 3 批战术决策）', () => {
    expect(isValidTransition('briefing', 'decision')).toBe(true)
    expect(isValidTransition('decision', 'persist')).toBe(true)
    // briefing 仍可直接进 persist（无决策时）
    expect(isValidTransition('briefing', 'persist')).toBe(true)
    // decision 不能跳回 briefing（单向）
    expect(isValidTransition('decision', 'briefing')).toBe(false)
  })
})

describe('guardAction — makeContext 兜底', () => {
  it('使用 makeContext 默认 idle 上下文', () => {
    const ctx = makeContext()
    expect(ctx.game.phase).toBe('idle')
    expect(guardAction(ctx, { type: 'START_TURN' })).toBeNull()
  })
})

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
  it('VALID_TRANSITIONS 表覆盖全部 7 阶段', () => {
    const phases = Object.keys(VALID_TRANSITIONS)
    expect(phases).toHaveLength(7)
    expect(phases.sort()).toEqual(
      ['briefing', 'handshake', 'idle', 'locked', 'persist', 'planning', 'resolution'],
    )
  })
})

describe('guardAction — makeContext 兜底', () => {
  it('使用 makeContext 默认 idle 上下文', () => {
    const ctx = makeContext()
    expect(ctx.game.phase).toBe('idle')
    expect(guardAction(ctx, { type: 'START_TURN' })).toBeNull()
  })
})

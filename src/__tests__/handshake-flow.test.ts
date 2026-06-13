/**
 * handshake-flow 编排测试（handshake-flow.test.ts）。
 *
 * 验证命令握手流程（planning → handshake → pendingOrders 累积 → lock → locked）：
 * - enterHandshake：planning → handshake；非 planning 被拒。
 * - submitOrder：planning/handshake 入队 pendingOrders；其他阶段被拒。
 * - lockOrders：handshake → locked，pendingOrders 并入 lockedOrders（按 faction）。
 * - buildEnvelope：构造的 ActionEnvelope 字段正确（sequence 段、state=pending）。
 * - canEnterHandshake/canSubmitNow/canLockNow 守卫判断正确。
 *
 * 经 reducer + guard，不绕过状态机。
 *
 * @module __tests__/handshake-flow
 */

import { describe, it, expect } from 'vitest'
import {
  enterHandshake,
  submitOrder,
  lockOrders,
  buildEnvelope,
  canEnterHandshake,
  canSubmitNow,
  canLockNow,
  HandshakeError,
} from '@/layers/application/orchestrator/handshake-flow'
import { makeContextAtPhase } from './test-helpers'
import type { ActionEnvelope } from '@/types'

/** 构造测试用 envelope */
function env(seq: number, faction = 'blue', intent = 'move'): ActionEnvelope {
  return buildEnvelope({
    turn: 0,
    faction,
    intent,
    payload: { unitId: 'u1', target: { col: 1, row: 1 } },
    sequence: seq,
  })
}

describe('enterHandshake — planning → handshake', () => {
  it('planning 进入 handshake', () => {
    const ctx = makeContextAtPhase('planning')
    const next = enterHandshake(ctx)
    expect(next.game.phase).toBe('handshake')
  })

  it('非 planning 阶段抛 HandshakeError', () => {
    const ctx = makeContextAtPhase('idle')
    expect(() => enterHandshake(ctx)).toThrow(HandshakeError)
  })

  it('canEnterHandshake 仅 planning 返回 true', () => {
    expect(canEnterHandshake(makeContextAtPhase('planning'))).toBe(true)
    expect(canEnterHandshake(makeContextAtPhase('handshake'))).toBe(false)
    expect(canEnterHandshake(makeContextAtPhase('idle'))).toBe(false)
  })
})

describe('submitOrder — 命令入队 pendingOrders', () => {
  it('planning 阶段入队', () => {
    const ctx = makeContextAtPhase('planning')
    const next = submitOrder(ctx, env(0))
    expect(next.pendingOrders).toHaveLength(1)
    expect(next.pendingOrders[0].sequence).toBe(0)
  })

  it('handshake 阶段入队（累积）', () => {
    const ctx = makeContextAtPhase('handshake')
    let next = submitOrder(ctx, env(0))
    next = submitOrder(next, env(1))
    expect(next.pendingOrders).toHaveLength(2)
  })

  it('idle 阶段入队抛 HandshakeError（阶段守卫）', () => {
    const ctx = makeContextAtPhase('idle')
    expect(() => submitOrder(ctx, env(0))).toThrow(HandshakeError)
  })

  it('locked 阶段入队抛 HandshakeError', () => {
    const ctx = makeContextAtPhase('locked')
    expect(() => submitOrder(ctx, env(0))).toThrow(HandshakeError)
  })

  it('canSubmitNow 在 planning/handshake 返回 true', () => {
    expect(canSubmitNow(makeContextAtPhase('planning'))).toBe(true)
    expect(canSubmitNow(makeContextAtPhase('handshake'))).toBe(true)
    expect(canSubmitNow(makeContextAtPhase('idle'))).toBe(false)
  })
})

describe('lockOrders — handshake → locked', () => {
  it('handshake 锁定，pendingOrders 并入 lockedOrders（按 faction）', () => {
    let ctx = makeContextAtPhase('planning')
    ctx = enterHandshake(ctx)
    ctx = submitOrder(ctx, env(0, 'blue'))
    ctx = submitOrder(ctx, env(1, 'red'))
    expect(ctx.pendingOrders).toHaveLength(2)

    const locked = lockOrders(ctx)
    expect(locked.game.phase).toBe('locked')
    expect(locked.pendingOrders).toHaveLength(0)
    expect(locked.lockedOrders['blue']).toHaveLength(1)
    expect(locked.lockedOrders['red']).toHaveLength(1)
  })

  it('planning 阶段锁定抛 HandshakeError（须先进 handshake）', () => {
    const ctx = makeContextAtPhase('planning')
    expect(() => lockOrders(ctx)).toThrow(HandshakeError)
  })

  it('canLockNow 仅 handshake 且有 pendingOrders 返回 true', () => {
    expect(canLockNow(makeContextAtPhase('planning'))).toBe(false)
    const empty = makeContextAtPhase('handshake')
    expect(canLockNow(empty)).toBe(false) // 无 pendingOrders
    let withOrder = makeContextAtPhase('handshake')
    withOrder = submitOrder(withOrder, env(0))
    expect(canLockNow(withOrder)).toBe(true)
  })
})

describe('buildEnvelope — 信封构造', () => {
  it('构造字段正确（chief 段 sequence、state=pending、agentRole=chief）', () => {
    const e = buildEnvelope({
      turn: 5,
      faction: 'blue',
      intent: 'move',
      payload: { unitId: 'u1', target: { col: 2, row: 3 } },
      sequence: 7,
    })
    expect(e.turn).toBe(5)
    expect(e.faction).toBe('blue')
    expect(e.agentRole).toBe('chief')
    expect(e.intent).toBe('move')
    expect(e.sequence).toBe(7)
    expect(e.state).toBe('pending')
    expect(e.requiresConfirmation).toBe(true)
    expect(e.payload.target).toEqual({ col: 2, row: 3 })
  })
})

describe('handshake-flow 完整闭环（planning → handshake → lock → locked）', () => {
  it('多条命令握手确认后锁定，全部并入 lockedOrders', () => {
    let ctx = makeContextAtPhase('planning')
    ctx = enterHandshake(ctx)
    ctx = submitOrder(ctx, env(0, 'blue', 'move'))
    ctx = submitOrder(ctx, env(1, 'blue', 'attack'))
    ctx = lockOrders(ctx)

    expect(ctx.game.phase).toBe('locked')
    expect(ctx.lockedOrders['blue']).toHaveLength(2)
    expect(ctx.lockedOrders['blue'].map((e) => e.intent)).toEqual(['move', 'attack'])
    expect(ctx.pendingOrders).toHaveLength(0)
  })
})

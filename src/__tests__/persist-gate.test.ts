/**
 * persist-gate 回归测试（persist-gate.test.ts）。
 *
 * 验证 persist-gate 在 orchestrator 层的运行时守卫：
 * - isPersistGateSatisfied：idle + persistCompleted。
 * - assertPersistGate：不满足时抛错。
 *
 * 与 reducer 内 NEXT_TURN 守卫形成双保险（reducer.test.ts 已覆盖纯函数层）。
 *
 * @module __tests__/persist-gate
 */

import { describe, it, expect } from 'vitest'
import {
  isPersistGateSatisfied,
  assertPersistGate,
} from '@/layers/application/orchestrator/persist-gate'
import { makeContextAtPhase } from './test-helpers'

describe('isPersistGateSatisfied', () => {
  it('idle + persistCompleted 满足', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = true
    expect(isPersistGateSatisfied(ctx)).toBe(true)
  })
  it('persistCompleted=false 不满足', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = false
    expect(isPersistGateSatisfied(ctx)).toBe(false)
  })
  it('非 idle 阶段不满足', () => {
    const ctx = makeContextAtPhase('persist')
    ctx.persistCompleted = true
    expect(isPersistGateSatisfied(ctx)).toBe(false)
  })
})

describe('assertPersistGate', () => {
  it('满足时不抛', () => {
    const ctx = makeContextAtPhase('idle')
    ctx.persistCompleted = true
    expect(() => assertPersistGate(ctx)).not.toThrow()
  })
  it('不满足时抛含 phase/persistCompleted 信息的错误', () => {
    const ctx = makeContextAtPhase('planning')
    ctx.persistCompleted = false
    expect(() => assertPersistGate(ctx)).toThrow(/persist-gate/)
    expect(() => assertPersistGate(ctx)).toThrow(/planning/)
  })
})

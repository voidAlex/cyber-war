/**
 * 预演目标坐标提取测试（extract-target.test.ts）— vitest。
 *
 * extractTargetCoord 是纯函数（不依赖 PixiJS），从 ActionEnvelope.payload
 * 宽容提取 move/capture 的目标坐标。命令解析器（M2 后续）落地前，payload
 * 字段名未定型，本测试覆盖多种候选命名与边界。
 *
 * @module layers/ui/sandbox/__tests__/extract-target
 */

import { describe, it, expect } from 'vitest'
import {
  extractTargetCoord,
  extractUnitId,
  isMoveLikeOrder,
} from '../payload'
import type { ActionEnvelope } from '@/types'

describe('extractTargetCoord', () => {
  it('读取 targetCoord', () => {
    expect(extractTargetCoord({ targetCoord: { col: 2, row: 3 } })).toEqual({
      col: 2,
      row: 3,
    })
  })

  it('读取 target', () => {
    expect(extractTargetCoord({ target: { col: 1, row: 1 } })).toEqual({
      col: 1,
      row: 1,
    })
  })

  it('读取 to', () => {
    expect(extractTargetCoord({ to: { col: 0, row: 0 } })).toEqual({
      col: 0,
      row: 0,
    })
  })

  it('读取 coord（顶层字段）', () => {
    expect(extractTargetCoord({ coord: { col: 5, row: 4 } })).toEqual({
      col: 5,
      row: 4,
    })
  })

  it('读取 destination', () => {
    expect(extractTargetCoord({ destination: { col: 3, row: 2 } })).toEqual({
      col: 3,
      row: 2,
    })
  })

  it('无任何坐标字段返回 null', () => {
    expect(extractTargetCoord({})).toBeNull()
    expect(extractTargetCoord({ kind: 'move' })).toBeNull()
  })

  it('坐标字段非 number 返回 null', () => {
    expect(extractTargetCoord({ targetCoord: { col: 'x', row: 1 } })).toBeNull()
    expect(extractTargetCoord({ target: { col: 1 } })).toBeNull()
  })

  it('NaN/Infinity 坐标返回 null', () => {
    expect(
      extractTargetCoord({ targetCoord: { col: Number.NaN, row: 1 } }),
    ).toBeNull()
    expect(
      extractTargetCoord({ target: { col: 1, row: Number.POSITIVE_INFINITY } }),
    ).toBeNull()
  })

  it('优先级：targetCoord 优先于 to', () => {
    expect(
      extractTargetCoord({
        targetCoord: { col: 1, row: 1 },
        to: { col: 9, row: 9 },
      }),
    ).toEqual({ col: 1, row: 1 })
  })
})

/** 构造最小 ActionEnvelope（仅填充 isMoveLikeOrder 用到的字段）。 */
function makeOrder(over: Partial<ActionEnvelope>): ActionEnvelope {
  return {
    turn: 0,
    faction: 'f1',
    agentId: 'a1',
    agentRole: 'chief',
    intent: '',
    payload: {},
    confidence: 1,
    requiresConfirmation: false,
    sequence: 0,
    state: 'pending',
    ...over,
  }
}

describe('extractUnitId', () => {
  it('读取 unitId', () => {
    expect(extractUnitId({ unitId: 'u-1' })).toBe('u-1')
  })

  it('宽容读取 unit / id', () => {
    expect(extractUnitId({ unit: 'u-2' })).toBe('u-2')
    expect(extractUnitId({ id: 'u-3' })).toBe('u-3')
  })

  it('无字段返回 null', () => {
    expect(extractUnitId({})).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(extractUnitId({ unitId: '' })).toBeNull()
  })
})

describe('isMoveLikeOrder', () => {
  it('payload.kind=move/capture/advance 命中', () => {
    expect(isMoveLikeOrder(makeOrder({ payload: { kind: 'move' } }))).toBe(true)
    expect(isMoveLikeOrder(makeOrder({ payload: { kind: 'Capture' } }))).toBe(true)
    expect(isMoveLikeOrder(makeOrder({ payload: { kind: 'advance' } }))).toBe(true)
  })

  it('intent 含移动/占领/推进 等关键词命中', () => {
    expect(isMoveLikeOrder(makeOrder({ intent: '第一装甲师移动至 C3' }))).toBe(true)
    expect(isMoveLikeOrder(makeOrder({ intent: 'occupy and capture the fort' }))).toBe(true)
    expect(isMoveLikeOrder(makeOrder({ intent: '向前推进 5 公里' }))).toBe(true)
    expect(isMoveLikeOrder(makeOrder({ intent: 'move north' }))).toBe(true)
  })

  it('非移动命令返回 false', () => {
    expect(isMoveLikeOrder(makeOrder({ intent: '请求补给', payload: { kind: 'supply' } }))).toBe(false)
    expect(isMoveLikeOrder(makeOrder({ intent: '炮击敌阵地' }))).toBe(false)
  })
})


/**
 * 局内日期纯函数助手单测（in-game-date.test.ts）。
 *
 * 验证：
 * - ISO 日期解析/格式化/推进（确定性，无时区漂移）。
 * - 非 ISO 日期（'D-0' 等旧存档）原样返回（不破坏旧数据）。
 * - Header 格式串「YYYY-MM-DD（第{n}天 D+{n}）」。
 *
 * @module __tests__/in-game-date
 */

import { describe, it, expect } from 'vitest'
import {
  isIsoInGameDate,
  advanceInGameDate,
  computeInGameDate,
  formatHeaderDate,
  DEFAULT_DAYS_PER_TURN,
} from '@/utils/in-game-date'

describe('in-game-date — ISO 判定', () => {
  it('识别合法 ISO 日期', () => {
    expect(isIsoInGameDate('1916-02-21')).toBe(true)
    expect(isIsoInGameDate('2024-12-31')).toBe(true)
  })
  it('拒绝非 ISO 日期（旧存档 D-N）', () => {
    expect(isIsoInGameDate('D-0')).toBe(false)
    expect(isIsoInGameDate('D+3')).toBe(false)
    expect(isIsoInGameDate('')).toBe(false)
  })
})

describe('in-game-date — advanceInGameDate', () => {
  it('ISO 日期 +1 天', () => {
    expect(advanceInGameDate('1916-02-21')).toBe('1916-02-22')
  })
  it('ISO 日期 +N 天（跨月/跨年）', () => {
    expect(advanceInGameDate('1916-02-28', 2)).toBe('1916-03-01')
    expect(advanceInGameDate('1916-12-31', 1)).toBe('1917-01-01')
  })
  it('非 ISO 日期原样返回（不破坏旧存档）', () => {
    expect(advanceInGameDate('D-0')).toBe('D-0')
    expect(advanceInGameDate('D+3', 5)).toBe('D+3')
  })
  it('默认 daysPerTurn = 1', () => {
    expect(DEFAULT_DAYS_PER_TURN).toBe(1)
  })
})

describe('in-game-date — computeInGameDate', () => {
  it('从开局日 + turnIndex 推算（凡尔登剧本）', () => {
    // turnIndex 0 = 开局日
    expect(computeInGameDate('1916-02-21', 0)).toBe('1916-02-21')
    // turnIndex 3 = D+3
    expect(computeInGameDate('1916-02-21', 3)).toBe('1916-02-24')
  })
  it('非 ISO 开局日返回 null（回退到 TURN 显示）', () => {
    expect(computeInGameDate('D-0', 5)).toBe(null)
    expect(computeInGameDate(undefined, 5)).toBe(null)
  })
})

describe('in-game-date — formatHeaderDate', () => {
  it('格式化「YYYY-MM-DD（第{n}天 D+{n}）」', () => {
    // 验收用例：startInGameDate='1916-02-21', turnIndex=3 → '1916-02-24（第4天 D+3）'
    expect(formatHeaderDate('1916-02-21', 3)).toBe('1916-02-24（第4天 D+3）')
  })
  it('turnIndex 0 = 开局日第 1 天', () => {
    expect(formatHeaderDate('1916-02-21', 0)).toBe('1916-02-21（第1天 D+0）')
  })
  it('非 ISO 开局日返回 null', () => {
    expect(formatHeaderDate(undefined, 3)).toBe(null)
    expect(formatHeaderDate('D-0', 3)).toBe(null)
  })
})

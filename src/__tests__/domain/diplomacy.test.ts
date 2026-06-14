/**
 * 外交信任度（diplomacy）单测。
 *
 * 验证：信任度变动钳制、履约/毁约、拒绝率阈值模型、倒戈概率、stance 推断。
 *
 * @module __tests__/domain/diplomacy
 */

import { describe, expect, it } from 'vitest'
import {
  applyTrustChange,
  applyHonor,
  applyBreak,
  clampTrust,
  computeRejectRate,
  computeDefectionProbability,
  isAtDefectionRisk,
  inferStance,
  buildDiplomacyEvent,
  computeTrustTrend,
  trustRecordFromValue,
  RECENT_TREND_WINDOW,
  TRUST_MIN,
  TRUST_MAX,
  REJECT_RATE_THRESHOLD,
  DEFECTION_THRESHOLD,
} from '@/layers/domain/diplomacy'
import type { DiplomacyTrust } from '@/types'

/** 构造信任度记录 */
function makeTrust(overrides: Partial<DiplomacyTrust> = {}): DiplomacyTrust {
  return {
    trust: 50,
    stance: 'neutral',
    honoredCount: 0,
    brokenCount: 0,
    lastChangeTurn: 0,
    ...overrides,
  }
}

describe('clampTrust / applyTrustChange', () => {
  it('钳制到 [0, 100]', () => {
    expect(clampTrust(-10)).toBe(TRUST_MIN)
    expect(clampTrust(150)).toBe(TRUST_MAX)
    expect(clampTrust(50)).toBe(50)
  })

  it('applyTrustChange 增减并钳制', () => {
    expect(applyTrustChange(50, 10)).toBe(60)
    expect(applyTrustChange(95, 10)).toBe(TRUST_MAX)
    expect(applyTrustChange(5, -10)).toBe(TRUST_MIN)
  })
})

describe('applyHonor / applyBreak', () => {
  it('履约 +8 并递增 honoredCount', () => {
    const result = applyHonor(makeTrust({ trust: 50, honoredCount: 2 }), 3)
    expect(result.trust.trust).toBe(58)
    expect(result.trust.honoredCount).toBe(3)
    expect(result.trust.lastChangeTurn).toBe(3)
  })

  it('履约不超上限', () => {
    const result = applyHonor(makeTrust({ trust: 98 }), 1)
    expect(result.trust.trust).toBe(TRUST_MAX)
  })

  it('毁约 -20 并递增 brokenCount', () => {
    const result = applyBreak(makeTrust({ trust: 60, brokenCount: 1 }), 5)
    expect(result.trust.trust).toBe(40)
    expect(result.trust.brokenCount).toBe(2)
    expect(result.delta).toBe(-20)
  })

  it('毁约不低于下限', () => {
    const result = applyBreak(makeTrust({ trust: 5 }), 1)
    expect(result.trust.trust).toBe(TRUST_MIN)
  })

  it('可自定义 delta', () => {
    expect(applyHonor(makeTrust({ trust: 50 }), 1, 10).trust.trust).toBe(60)
    expect(applyBreak(makeTrust({ trust: 50 }), 1, -25).trust.trust).toBe(25)
  })
})

describe('computeRejectRate', () => {
  it('信任度 >= 30 拒绝率为基线 0.2', () => {
    expect(computeRejectRate(30)).toBeCloseTo(0.2, 5)
    expect(computeRejectRate(60)).toBeCloseTo(0.2, 5)
    expect(computeRejectRate(100)).toBeCloseTo(0.2, 5)
  })

  it('信任度 = 0 拒绝率为 1.0', () => {
    expect(computeRejectRate(0)).toBeCloseTo(1.0, 5)
  })

  it('信任度 15（<30）拒绝率介于 0.2 与 1.0 之间', () => {
    const r = computeRejectRate(15)
    expect(r).toBeGreaterThan(0.2)
    expect(r).toBeLessThan(1.0)
  })

  it('拒绝率随信任度下降而上升（单调）', () => {
    const r25 = computeRejectRate(25)
    const r15 = computeRejectRate(15)
    const r5 = computeRejectRate(5)
    expect(r15).toBeGreaterThan(r25)
    expect(r5).toBeGreaterThan(r15)
  })
})

describe('computeDefectionProbability', () => {
  it('信任度 >= 15 倒戈概率为 0', () => {
    expect(computeDefectionProbability(15)).toBe(0)
    expect(computeDefectionProbability(50)).toBe(0)
  })

  it('信任度 = 0 倒戈概率为 0.8', () => {
    expect(computeDefectionProbability(0)).toBeCloseTo(0.8, 5)
  })

  it('信任度 7（<15）倒戈概率介于 0 与 0.8', () => {
    const p = computeDefectionProbability(7)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(0.8)
  })

  it('isAtDefectionRisk：< 15 为 true', () => {
    expect(isAtDefectionRisk(14)).toBe(true)
    expect(isAtDefectionRisk(15)).toBe(false)
  })
})

describe('inferStance', () => {
  it('按信任度阈值推断 stance', () => {
    expect(inferStance(70)).toBe('ally')
    expect(inferStance(60)).toBe('ally')
    expect(inferStance(45)).toBe('neutral')
    expect(inferStance(30)).toBe('neutral')
    expect(inferStance(20)).toBe('enemy')
    expect(inferStance(10)).toBe('war')
    expect(inferStance(0)).toBe('war')
  })
})

describe('buildDiplomacyEvent', () => {
  it('构造外交事件记录', () => {
    const ev = buildDiplomacyEvent(5, 'blue', 'red', 'honor', 8, 58)
    expect(ev).toMatchObject({
      turn: 5,
      fromFactionId: 'blue',
      toFactionId: 'red',
      kind: 'honor',
      delta: 8,
      trustAfter: 58,
    })
  })
})

describe('阈值常量一致性', () => {
  it('常量与文档草案一致', () => {
    expect(REJECT_RATE_THRESHOLD).toBe(30)
    expect(DEFECTION_THRESHOLD).toBe(15)
  })
})

describe('computeTrustTrend（趋势推断）', () => {
  it('从未变动（lastChangeTurn=0）恒 stable', () => {
    const trust = makeTrust({ honoredCount: 3, brokenCount: 0, lastChangeTurn: 0 })
    expect(computeTrustTrend(trust, 1)).toBe('stable')
    expect(computeTrustTrend(trust, 10)).toBe('stable')
  })
  it('近期履约多于毁约 → rising', () => {
    const trust = makeTrust({ honoredCount: 2, brokenCount: 0, lastChangeTurn: 4 })
    expect(computeTrustTrend(trust, 5)).toBe('rising')
    // 刚好在窗口边界（recentChange === RECENT_TREND_WINDOW）
    expect(computeTrustTrend(trust, 4 + RECENT_TREND_WINDOW)).toBe('rising')
  })
  it('近期毁约多于履约 → falling', () => {
    const trust = makeTrust({ honoredCount: 0, brokenCount: 2, lastChangeTurn: 4 })
    expect(computeTrustTrend(trust, 5)).toBe('falling')
  })
  it('履约毁约持平 → stable', () => {
    const trust = makeTrust({ honoredCount: 1, brokenCount: 1, lastChangeTurn: 4 })
    expect(computeTrustTrend(trust, 5)).toBe('stable')
  })
  it('超出近期窗口 → stable', () => {
    const trust = makeTrust({ honoredCount: 5, brokenCount: 0, lastChangeTurn: 2 })
    // recentChange = 5 - 2 = 3 > 2 窗口
    expect(computeTrustTrend(trust, 5)).toBe('stable')
  })
})

describe('trustRecordFromValue（兜底构造）', () => {
  it('按数值构造记录，计数归零、趋势 stable', () => {
    const rec = trustRecordFromValue(60)
    expect(rec.trust).toBe(60)
    expect(rec.stance).toBe('ally')
    expect(rec.honoredCount).toBe(0)
    expect(rec.brokenCount).toBe(0)
    expect(rec.lastChangeTurn).toBe(0)
    expect(computeTrustTrend(rec, 5)).toBe('stable')
  })
  it('显式 stance 覆盖推断', () => {
    const rec = trustRecordFromValue(60, 'neutral')
    expect(rec.stance).toBe('neutral')
  })
  it('钳制超界数值', () => {
    expect(trustRecordFromValue(150).trust).toBe(100)
    expect(trustRecordFromValue(-5).trust).toBe(0)
  })
})

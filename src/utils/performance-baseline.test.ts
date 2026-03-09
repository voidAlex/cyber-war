import { describe, expect, it } from 'vitest'

import {
  calculateFrameMetrics,
  formatPerformanceReport,
  isFrameRateAcceptable,
  isSettlementWindowAcceptable,
} from './performance-baseline'

describe('performance-baseline', () => {
  it('应计算平均帧时、P95 与估算 FPS', () => {
    const metrics = calculateFrameMetrics([16, 17, 15, 16.5, 20, 14])

    expect(metrics.averageFrameTimeMs).toBeGreaterThan(0)
    expect(metrics.p95FrameTimeMs).toBeGreaterThanOrEqual(metrics.averageFrameTimeMs)
    expect(metrics.estimatedFps).toBeGreaterThan(45)
    expect(metrics.droppedFrameRatio).toBeGreaterThanOrEqual(0)
    expect(metrics.droppedFrameRatio).toBeLessThanOrEqual(1)
  })

  it('空输入时应返回零值指标', () => {
    const metrics = calculateFrameMetrics([])
    expect(metrics).toEqual({
      averageFrameTimeMs: 0,
      p95FrameTimeMs: 0,
      estimatedFps: 0,
      droppedFrameRatio: 0,
    })
  })

  it('应根据阈值判断帧率是否可接受', () => {
    const goodMetrics = calculateFrameMetrics([16.1, 16.2, 16.0, 16.4, 16.3])
    const badMetrics = calculateFrameMetrics([18, 22, 24, 19, 21, 23])

    expect(isFrameRateAcceptable(goodMetrics)).toBe(true)
    expect(isFrameRateAcceptable(badMetrics)).toBe(false)
  })

  it('应判断结算窗口是否位于11-15秒', () => {
    expect(isSettlementWindowAcceptable(11000)).toBe(true)
    expect(isSettlementWindowAcceptable(15000)).toBe(true)
    expect(isSettlementWindowAcceptable(10999)).toBe(false)
    expect(isSettlementWindowAcceptable(15001)).toBe(false)
  })

  it('应格式化性能报告文本', () => {
    const report = formatPerformanceReport({
      scenario: 'm2-sandbox',
      turn: 5,
      measuredAt: '2026-03-09T00:00:00.000Z',
      frameMetrics: calculateFrameMetrics([16, 17, 16, 15]),
      resolutionTiming: {
        totalResolutionMs: 12000,
        firstChunkMs: 450,
        agentTimingMs: {
          chief_of_staff: 3200,
          theater_commander_player: 3100,
        },
      },
      acceptance: {
        frameRatePass: true,
        settlementWindowPass: true,
      },
    })

    expect(report).toContain('性能测量报告')
    expect(report).toContain('11-15s 结算窗口：通过')
  })
})

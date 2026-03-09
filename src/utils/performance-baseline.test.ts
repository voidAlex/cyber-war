import { describe, expect, it } from 'vitest'

import { calculateFrameMetrics, isFrameRateAcceptable } from './performance-baseline'

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
})

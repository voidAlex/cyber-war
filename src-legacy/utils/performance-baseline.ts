export interface FrameMetrics {
  averageFrameTimeMs: number
  p95FrameTimeMs: number
  estimatedFps: number
  droppedFrameRatio: number
}

export interface ResolutionTimingMetrics {
  totalResolutionMs: number
  firstChunkMs: number
  agentTimingMs: Record<string, number>
}

export interface PerformanceReport {
  scenario: string
  turn: number
  measuredAt: string
  frameMetrics: FrameMetrics
  resolutionTiming: ResolutionTimingMetrics
  acceptance: {
    frameRatePass: boolean
    settlementWindowPass: boolean
  }
}

function computePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentile)))
  return sorted[index] ?? 0
}

export function calculateFrameMetrics(frameDurationsMs: number[]): FrameMetrics {
  if (frameDurationsMs.length === 0) {
    return {
      averageFrameTimeMs: 0,
      p95FrameTimeMs: 0,
      estimatedFps: 0,
      droppedFrameRatio: 0,
    }
  }

  const total = frameDurationsMs.reduce((sum, value) => sum + value, 0)
  const averageFrameTimeMs = total / frameDurationsMs.length
  const p95FrameTimeMs = computePercentile(frameDurationsMs, 0.95)
  const estimatedFps = averageFrameTimeMs > 0 ? 1000 / averageFrameTimeMs : 0
  const droppedFrames = frameDurationsMs.filter(duration => duration > 16.7).length
  const droppedFrameRatio = droppedFrames / frameDurationsMs.length

  return {
    averageFrameTimeMs,
    p95FrameTimeMs,
    estimatedFps,
    droppedFrameRatio,
  }
}

export function isFrameRateAcceptable(
  metrics: FrameMetrics,
  options?: {
    minFps?: number
    maxDroppedFrameRatio?: number
    maxP95FrameTimeMs?: number
  }
): boolean {
  const minFps = options?.minFps ?? 55
  const maxDroppedFrameRatio = options?.maxDroppedFrameRatio ?? 0.1
  const maxP95FrameTimeMs = options?.maxP95FrameTimeMs ?? 20

  return (
    metrics.estimatedFps >= minFps &&
    metrics.droppedFrameRatio <= maxDroppedFrameRatio &&
    metrics.p95FrameTimeMs <= maxP95FrameTimeMs
  )
}

export function isSettlementWindowAcceptable(
  totalResolutionMs: number,
  options?: {
    minMs?: number
    maxMs?: number
  }
): boolean {
  const minMs = options?.minMs ?? 11000
  const maxMs = options?.maxMs ?? 15000
  return totalResolutionMs >= minMs && totalResolutionMs <= maxMs
}

export function formatPerformanceReport(report: PerformanceReport): string {
  return [
    `# 性能测量报告`,
    ``,
    `- 场景：${report.scenario}`,
    `- 回合：${report.turn}`,
    `- 测量时间：${report.measuredAt}`,
    ``,
    `## 沙盘渲染`,
    `- 平均帧时：${report.frameMetrics.averageFrameTimeMs.toFixed(2)} ms`,
    `- P95 帧时：${report.frameMetrics.p95FrameTimeMs.toFixed(2)} ms`,
    `- 估算 FPS：${report.frameMetrics.estimatedFps.toFixed(2)}`,
    `- 掉帧比：${(report.frameMetrics.droppedFrameRatio * 100).toFixed(2)}%`,
    ``,
    `## 结算时序`,
    `- 总结算耗时：${report.resolutionTiming.totalResolutionMs.toFixed(0)} ms`,
    `- 首个战报分片：${report.resolutionTiming.firstChunkMs.toFixed(0)} ms`,
    `- Agent 耗时：${JSON.stringify(report.resolutionTiming.agentTimingMs)}`,
    ``,
    `## 验收判定`,
    `- 60fps 指标：${report.acceptance.frameRatePass ? '通过' : '不通过'}`,
    `- 11-15s 结算窗口：${report.acceptance.settlementWindowPass ? '通过' : '不通过'}`,
    ``,
  ].join('\n')
}

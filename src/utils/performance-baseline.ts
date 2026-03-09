export interface FrameMetrics {
  averageFrameTimeMs: number
  p95FrameTimeMs: number
  estimatedFps: number
  droppedFrameRatio: number
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

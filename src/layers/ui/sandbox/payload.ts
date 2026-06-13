/**
 * 命令载荷提取（payload.ts）— 纯函数，不依赖 PixiJS。
 *
 * 从 ActionEnvelope.payload 防御性提取 move/capture 的目标坐标与单位 id。
 * 单独成文件（而非放进 SandboxRenderer.ts）是为了让纯函数测试可在
 * Node 环境跑：直接 import pixi.js 会在模块加载期触发浏览器环境检测
 * （navigator），导致 vitest 报错。把无副作用的提取逻辑隔离在此文件，
 * SandboxRenderer 与测试都从本文件 import，互不拉起 pixi。
 *
 * 命令解析器（M2 后续任务）落地前，payload 字段名未定型。这里宽容读取
 * 多种常见命名（targetCoord/target/to/coord/destination），保证渲染层
 * 在 parser 落地前后都能工作。
 *
 * @module layers/ui/sandbox/payload
 */

import type { ActionEnvelope, GridCoord } from '@/types'

/**
 * 从 payload 防御性提取 move/capture 的目标坐标。
 *
 * 按候选 key 顺序读取，命中即返回。提取失败返回 null（该订单不画预演线）。
 */
export function extractTargetCoord(
  payload: Record<string, unknown>,
): GridCoord | null {
  const candidates: unknown[] = [
    payload.targetCoord,
    payload.target,
    payload.to,
    payload.coord,
    payload.destination,
    payload,
  ]
  for (const c of candidates) {
    const coord = readCoord(c)
    if (coord !== null) return coord
  }
  return null
}

/** 从一个 unknown 值尝试读 {col,row}，非法返回 null。 */
export function readCoord(value: unknown): GridCoord | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const col = v.col
  const row = v.row
  if (typeof col !== 'number' || typeof row !== 'number') return null
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null
  return { col, row }
}

/** 从 payload 宽容读取字符串字段（按候选 key 顺序，返回首个非空字符串）。 */
export function readString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = payload[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/**
 * 提取 move/capture 类订单的目标单位 id。
 *
 * 宽容读取 unitId/unit/id。提取失败返回 null。
 */
export function extractUnitId(
  payload: Record<string, unknown>,
): string | null {
  return readString(payload, ['unitId', 'unit', 'id'])
}

/**
 * 判断订单是否为 move/capture 类（用于预演虚线过滤）。
 *
 * 宽容判断：payload.kind 命中 move/capture/advance，
 * 或 intent 文本含 move/移动/capture/占领/advance/推进。
 */
export function isMoveLikeOrder(order: ActionEnvelope): boolean {
  const kind = order.payload.kind
  if (typeof kind === 'string') {
    const k = kind.toLowerCase()
    if (k === 'move' || k === 'capture' || k === 'advance') return true
  }
  const intent = order.intent.toLowerCase()
  return (
    intent.includes('move') ||
    intent.includes('移动') ||
    intent.includes('capture') ||
    intent.includes('占领') ||
    intent.includes('advance') ||
    intent.includes('推进')
  )
}

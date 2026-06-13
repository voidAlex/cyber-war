/**
 * 物理引擎 Web Worker（physics.worker.ts）— 占位。
 *
 * 物理结算跑在 Web Worker，隔离主线程不卡 UI（TDD 决策#10）。
 * Worker 接收结算请求，调用 domain/physics-rules 纯函数计算，返回结果。
 * 确定性种子 = scenarioSeed:turn:seq，固定 seed 结果可复现。
 *
 * 里程碑：M2（物理 Worker + physics-rules 完整实现）。
 *
 * @module workers/physics
 */

import type { WorldState } from '@/types'

/**
 * Worker 接收的结算请求（草案，M2 完善）。
 */
export interface PhysicsWorkerRequest {
  /** 当前世界状态快照 */
  world: WorldState
  /** 确定性种子 */
  seed: string
  /** 本回合锁定的命令序号列表 */
  sequenceList: number[]
}

/**
 * Worker 返回的结算结果（草案，M2 完善）。
 */
export interface PhysicsWorkerResponse {
  /** 结算后的世界状态（不可变产出） */
  world: WorldState
  /** 结算明细（战损等，写入 event-log） */
  details: Record<string, unknown>
}

/**
 * Worker 消息处理入口（占位）。
 *
 * TODO(M2): 由后续子代理接入 domain/physics-rules 与 combat 纯函数，
 * 实现完整的 Worker 消息循环与可复现结算。
 */
self.onmessage = (_event: MessageEvent<PhysicsWorkerRequest>): void => {
  // TODO(M2): 接收请求 → 调 physics-rules 纯函数 → postMessage 返回结果
  void _event
}

// 导出类型供主线程（worker-client）引用
export type { PhysicsWorkerRequest as _PhysicsWorkerRequest, PhysicsWorkerResponse as _PhysicsWorkerResponse }

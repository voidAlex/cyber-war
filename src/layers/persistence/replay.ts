/**
 * 回放桩（replay.ts）。
 *
 * 从 snapshot + event-log 恢复到任意回合（验收#7 红线）。
 * physics 类校验重算一致，director 类直接采信原文不重算。
 * 确定性 CI 门：固定种子 30 回合回归比对 event-log 哈希。
 *
 * 里程碑：M3（回放回归测试）。
 *
 * @module layers/persistence/replay
 */

import type { WorldState } from '@/types'

/**
 * 从快照 + event-log 回放到指定回合。
 * TODO(M3): 由后续子代理实现回放逻辑（physics 重算 / director 采信）。
 */
export async function replayToTurn(_saveId: string, _turn: number): Promise<WorldState | null> {
  // TODO(M3): 回放逻辑
  return null
}

/**
 * 快照桩（snapshot.ts）。
 *
 * 周期性把 WorldState 写入 snapshot.json（Rust 原子写），
 * 用于崩溃恢复与回放加速（从最近快照起回放）。
 *
 * 里程碑：M1（snapshot 原子写）。
 *
 * @module layers/persistence/snapshot
 */

import type { WorldState } from '@/types'

/**
 * 写快照桩。
 * TODO(M1): tauriBridge.fsWriteSnapshot()（序列化 WorldState）。
 */
export async function writeSnapshot(_saveId: string, _world: WorldState): Promise<void> {
  // TODO(M1): tauriBridge.fsWriteSnapshot()
}

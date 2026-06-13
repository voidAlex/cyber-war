/**
 * 快照（snapshot.ts）— 周期性把 WorldState 写入 snapshot.json（Rust 原子写）。
 *
 * 用途（重写计划「回放从日志恢复」+ TDD §3.5）：
 * - **崩溃恢复**：snapshot 是回放加速锚点——回放时取最近快照作 baseWorld，
 *   其后的事件逐条重放（避免从 T0 全量重放）。
 * - **回放加速**：每个 persist 阶段写一次快照，把「确定性两层」中的物理层
 *   已结算状态固化，回放只需 replay 快照之后的 director/rule-engine 增量。
 *
 * 经 @gateway/tauri-bridge 调 Rust fs_write_snapshot（临时文件 + rename 原子写），
 * 读经 fs_read_snapshot（不存在时返回 null，上层回退到 world-state.json）。
 *
 * 里程碑：M3（配合 replay 回归测试 + 端到端确定性验证）。
 *
 * @module layers/persistence/snapshot
 */

import type { WorldState, TurnSnapshot } from '@/types'
import { fsWriteSnapshot, fsReadSnapshot } from '@/layers/gateway/tauri-bridge'

/**
 * 构造回合快照：深拷贝 world + 记录 turn/phase/scenarioSeed。
 *
 * 深拷贝用 structuredClone（WorldState 全可结构化克隆，无函数/循环引用），
 * 保证后续修改 world 不污染快照，回放读到的就是当时状态。
 *
 * 注意：createdAt 用 ISO 时间戳——快照元信息不参与 reducer 确定性链路
 * （与 manifest 同），允许时间戳。
 *
 * @param world 当前世界状态
 * @param phase 快照时的阶段（如 'persist' / 'briefing'）
 */
export function createTurnSnapshot(world: WorldState, phase: string): TurnSnapshot {
  return {
    saveId: world.saveId,
    turnIndex: world.turnIndex,
    phase,
    scenarioSeed: world.scenarioSeed,
    createdAt: new Date().toISOString(),
    // 深拷贝：保证快照不可变，回放读到的就是当时状态
    world: structuredClone(world),
  }
}

/**
 * 从快照还原 WorldState（深拷贝，避免后续修改污染快照）。
 *
 * 回放时把 baseWorld 取最近快照，其后事件重放（见 replay.ts）。
 *
 * @param snap 回合快照
 */
export function loadTurnSnapshot(snap: TurnSnapshot): WorldState {
  // 深拷贝返回：调用方对返回值的修改不应污染传入快照
  return structuredClone(snap.world)
}

/**
 * 原子写快照到 snapshot.json（经 gateway 调 fs_write_snapshot 临时文件+rename）。
 *
 * @param saveId 存档 id
 * @param snap 待写入的快照
 */
export async function writeSnapshot(saveId: string, snap: TurnSnapshot): Promise<void> {
  const content = JSON.stringify(snap)
  await fsWriteSnapshot(saveId, content)
}

/**
 * 读取最近快照（snapshot.json）。
 *
 * 不存在 / 损坏时返回 null（上层回退到 world-state.json 或空世界）。
 * 损坏恢复语义：readTurnSnapshot 返回 null 时，调用方用 saveRepository.getWorldState
 * 作 baseWorld（world-state.json 是唯一真相源兜底）。
 *
 * @param saveId 存档 id
 */
export async function readSnapshot(saveId: string): Promise<TurnSnapshot | null> {
  try {
    const raw = await fsReadSnapshot(saveId)
    if (!raw) return null
    return JSON.parse(raw) as TurnSnapshot
  } catch {
    // 文件不存在或解析失败：返回 null，上层回退到 world-state
    return null
  }
}

/**
 * 事件日志（event-log.ts）— 真追加 O(1)。
 *
 * event-log.jsonl 每行一条 AgentAction（标 source: physics/director/rule-engine）。
 * 经 @gateway/tauri-bridge 调 `fs_append_event`（Rust OpenOptions::append 真追加），
 * 取代旧 OPFS 伪追加 O(n²)。
 *
 * 回放从日志恢复（验收#7 红线）：physics 类校验重算，director 类直接采信。
 *
 * @module layers/persistence/event-log
 */

import type { AgentAction } from '@/types'
import { fsAppendEvent, fsReadEventLog } from '@/layers/gateway/tauri-bridge'

/**
 * 追加一条事件到 event-log.jsonl（真追加 O(1)）。
 *
 * 序列化为单行 JSON（保证一行一条，便于 fs_read_event_log 分页读取）。
 *
 * @param saveId 存档 id
 * @param action 待追加的 AgentAction
 */
export async function appendEvent(saveId: string, action: AgentAction): Promise<void> {
  const line = JSON.stringify(action)
  await fsAppendEvent(saveId, line)
}

/**
 * 批量追加事件（顺序追加，保证 event-log 顺序与 action 顺序一致）。
 *
 * @param saveId 存档 id
 * @param actions 待追加的 AgentAction 列表
 */
export async function appendEvents(saveId: string, actions: AgentAction[]): Promise<void> {
  for (const action of actions) {
    await appendEvent(saveId, action)
  }
}

/**
 * 分页读取 event-log（每行解析为 AgentAction）。
 *
 * @param saveId 存档 id
 * @param offset 起始行偏移
 * @param limit 读取行数
 * @returns AgentAction 列表
 */
export async function readEventLog(
  saveId: string,
  offset: number,
  limit: number,
): Promise<AgentAction[]> {
  const lines = await fsReadEventLog(saveId, offset, limit)
  const actions: AgentAction[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      actions.push(JSON.parse(trimmed) as AgentAction)
    } catch {
      // 损坏行跳过（不阻断回放，由 diagnostics 记录）
      continue
    }
  }
  return actions
}

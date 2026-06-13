/**
 * Agent 协议桩 — context-builder（protocol/context-builder.ts）。
 *
 * **纯函数边界**：严格按 L0-L3 缓存分层构造 messages，让 prompt 前缀稳定且跨请求重复
 * （吃满 DeepSeek 等硬盘 KV 缓存红利）。
 *
 * 强制规则：system prompt 固定，禁止注入回合号/时间戳/UUID（这些只能放 L3 尾部）；
 * 战役数据 L1 开局后冻结；多 Agent 共享同一份 L0+L1+L2 前缀。
 *
 * 里程碑：M3（多 Agent 编排）。
 *
 * @module layers/agents/protocol/context-builder
 */

import type { AgentContext } from '@/types'

/**
 * 上下文构造器桩。
 * TODO(M3): 由后续子代理实现 L0-L3 分层构造（稳定→易变）。
 */
export function buildContext(_parts: {
  systemPrompt: string
  worldSummary: string
  instruction: string
}): AgentContext {
  // TODO(M3): 严格分层构造，禁止前缀注入时间戳/UUID
  return {
    systemPrompt: _parts.systemPrompt,
    worldSummary: _parts.worldSummary,
    instruction: _parts.instruction,
    history: [],
  }
}

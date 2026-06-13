/**
 * LLM 服务桩（llm-service.ts）— 副作用出口。
 *
 * 封装多 Agent 编排对 LLM 的调用，经 @gateway/llm-client 走 Rust 真流式转发。
 * 错误四分类（network/api_key/llm_error/timeout）由 Rust 侧判定，本服务不再猜。
 *
 * 里程碑：M3（多 Agent 真流式编排）；M1/M2 仅占位。
 *
 * @module layers/application/services/llm-service
 */

import type { AgentContext } from '@/types'

/**
 * LLM 服务桩。
 * TODO(M3): 由后续子代理接入 llm-client 实现真流式消费与多 Agent 编排。
 */
export const llmService = {
  /**
   * 发起一次 LLM 流式请求（经 gateway/llm-client）。
   * TODO(M3): 接入 Rust llm_stream_forward 的 Channel 订阅。
   */
  async stream(_ctx: AgentContext): Promise<string> {
    // TODO(M3): 真流式消费 + usage 透传 + 错误四分类处理
    return ''
  },
}

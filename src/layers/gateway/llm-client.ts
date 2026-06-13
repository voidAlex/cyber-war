/**
 * LLM 客户端桩（llm-client.ts）— 唯一 import `@tauri-apps/api` 的层。
 *
 * 封装 `llm_stream_forward` 的 Channel 订阅：前端创建 Channel，订阅 onmessage
 * 接收 LlmStreamEvent（delta/usage/done/error），Rust reqwest 真流式透传。
 *
 * 安全：endpoint 经 Rust guard 校验（白名单 + 私网拒绝 + 生产 https）；
 * api_key 仅作参数透传，绝不写日志；payload 不解析游戏语义。
 * 错误四分类由 Rust 侧判定，前端不再猜。
 *
 * 里程碑：M1 占位桩 / M3 填真流式消费。
 *
 * @module layers/gateway/llm-client
 */

import { Channel } from '@tauri-apps/api/core'
import { invoke } from '@tauri-apps/api/core'
import type {
  LlmForwardArgs,
  LlmFinalResult,
  LlmStreamEvent,
} from './bridge-types'

/**
 * 流式消费回调集合。
 */
export interface LlmStreamHandlers {
  /** 收到增量文本（每段 data: 立即回调） */
  onDelta: (text: string) => void
  /** 末帧 usage（透传 DeepSeek 缓存命中统计） */
  onUsage?: (usage: {
    promptCacheHitTokens: number | null
    promptCacheMissTokens: number | null
    inputTokens: number | null
    outputTokens: number | null
  }) => void
  /** 单次请求结束（正常） */
  onDone?: () => void
  /** 错误（带四分类 kind） */
  onError?: (kind: LlmStreamEvent extends { type: 'error' } ? never : never) => void
}

/**
 * 发起一次真流式 LLM 转发（订阅 Channel 接收流式事件）。
 *
 * TODO(M3): 由后续子代理填真流式消费逻辑（TTFT<200ms、usage 透传、错误四分类降级）。
 *
 * @param args 转发参数（provider/endpoint/apiKey/payload）
 * @param handlers 流式事件回调
 * @returns 最终结果（含 degraded 标志，前端据此切规则引擎）
 */
export async function streamForward(
  args: LlmForwardArgs,
  handlers: LlmStreamHandlers,
): Promise<LlmFinalResult> {
  // 创建 Channel 订阅 Rust 端 emit 的事件
  const channel = new Channel<LlmStreamEvent>()
  channel.onmessage = (event) => {
    switch (event.type) {
      case 'delta':
        handlers.onDelta(event.text)
        break
      case 'usage':
        handlers.onUsage?.({
          promptCacheHitTokens: event.promptCacheHitTokens,
          promptCacheMissTokens: event.promptCacheMissTokens,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        })
        break
      case 'done':
        handlers.onDone?.()
        break
      case 'error':
        // 错误四分类：Rust 侧已判，前端直接采信（kind: network/api_key/llm_error/timeout）
        handlers.onError?.(event.kind as never)
        break
    }
  }

  // 调用 Rust llm_stream_forward（on_event 作为 Channel 参数传入）
  // 注意：invoke 的参数名必须与 commands.rs #[tauri::command] 的参数名严格一致。
  const result = await invoke<LlmFinalResult>('llm_stream_forward', {
    provider: args.provider,
    endpoint: args.endpoint,
    apiKey: args.apiKey,
    payload: args.payload,
    onEvent: channel,
  })
  return result
}

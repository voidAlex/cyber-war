/**
 * Gateway 桥类型契约（bridge-types.ts）— 与 Rust 侧 serde 结构一一对齐。
 *
 * 这些类型镜像 Rust 源码（keyring_store.rs、llm/stream.rs、llm/router.rs、error.rs），
 * 作为前后端 IPC 的强类型契约。**修改 Rust 侧时务必同步此处**。
 *
 * 去口令改造后：旧 `EncryptedPayload`（对齐 crypto/aead.rs）已删，apiKey 经
 * OS 凭证库存取，非密钥字段明文 JSON 落盘。
 *
 * @module layers/gateway/bridge-types
 */

/**
 * LLM provider 标识（对齐 llm/router.rs `ProviderKind`，serde rename_all="lowercase"）。
 */
export type ProviderKindString = 'deepseek' | 'openai' | 'anthropic' | 'custom'

/**
 * LLM 错误四分类（对齐 error.rs `LlmErrorKind.as_str()`）。
 */
export type LlmErrorKindString = 'network' | 'api_key' | 'llm_error' | 'timeout'

/**
 * LLM 流式事件（对齐 llm/stream.rs `LlmStreamEvent`，
 * serde tag="type" rename_all="snake_case"）。
 *
 * 通过 Tauri `Channel<LlmStreamEvent>` 传输，前端订阅 onmessage 接收。
 */
export type LlmStreamEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'usage'
      promptCacheHitTokens: number | null
      promptCacheMissTokens: number | null
      inputTokens: number | null
      outputTokens: number | null
    }
  | { type: 'done' }
  | { type: 'error'; kind: LlmErrorKindString; message: string }

/**
 * 一次完整转发的最终结果（对齐 llm/stream.rs `LlmFinalResult`）。
 * degraded=true 时前端切规则引擎兜底（修订点 E）。
 */
export interface LlmFinalResult {
  /** 是否降级（3 次重试均失败时为 true） */
  degraded: boolean
  /** 末帧 usage（若 provider 返回） */
  promptCacheHitTokens: number | null
  promptCacheMissTokens: number | null
  /** 输入 token 数（通用） */
  inputTokens: number | null
  /** 输出 token 数（通用） */
  outputTokens: number | null
}

/**
 * 一次 LLM 转发请求的输入（对齐 llm/mod.rs `ForwardRequest`，
 * 经 commands.rs `llm_stream_forward` 的具名参数传入）。
 */
export interface LlmForwardArgs {
  /** provider 标识（deepseek/openai/anthropic/custom） */
  provider: ProviderKindString
  /** 目标 endpoint URL（custom 由前端指定，其余由 router 决定） */
  endpoint: string
  /** API key（即用即抛，不缓存；Rust 侧绝不写日志） */
  apiKey: string
  /** 请求体（透传，Rust 不解析游戏语义） */
  payload: unknown
}

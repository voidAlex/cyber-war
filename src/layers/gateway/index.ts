/**
 * Gateway 层 barrel — **唯一允许 import `@tauri-apps/api` 的层**。
 *
 * 上层（application/services、persistence 等）一律经此 barrel 调用 Tauri 能力，
 * 严禁其他层直接 import `@tauri-apps/api`（铁律，AGENTS.md）。
 *
 * 导出：
 * - tauri-bridge：fs_* / crypto_* / llm_set_allowed_hosts invoke 封装
 * - llm-client：llm_stream_forward 的 Channel 订阅封装
 * - crypto-client：加解密便捷封装
 * - bridge-types：与 Rust serde 结构对齐的类型契约
 *
 * @module layers/gateway
 */

export * from './tauri-bridge'
export { streamForward } from './llm-client'
export type { LlmStreamHandlers } from './llm-client'
export { encryptApiKey, decryptApiKey } from './crypto-client'
export type {
  EncryptedPayload,
  ProviderKindString,
  LlmErrorKindString,
  LlmStreamEvent,
  LlmFinalResult,
  LlmForwardArgs,
} from './bridge-types'

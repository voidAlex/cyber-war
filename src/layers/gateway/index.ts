/**
 * Gateway 层 barrel — **唯一允许 import `@tauri-apps/api` 的层**。
 *
 * 上层（application/services、persistence 等）一律经此 barrel 调用 Tauri 能力，
 * 严禁其他层直接 import `@tauri-apps/api`（铁律，AGENTS.md）。
 *
 * 导出：
 * - tauri-bridge：fs_* / llm_key_* / llm_config_* / llm_set_allowed_hosts invoke 封装
 * - llm-client：llm_stream_forward 的 Channel 订阅封装
 * - runtime-config：apiKey 经 OS 凭证库 + 非密钥字段明文 config 的会话管理
 * - bridge-types：与 Rust serde 结构对齐的类型契约
 *
 * 去口令改造后：删 crypto-client（加解密封装，apiKey 改 OS 凭证库不再需要应用层加密）。
 *
 * @module layers/gateway
 */

export * from './tauri-bridge'
export {
  streamChat,
  streamForward,
  LlmStreamError,
} from './llm-client'
export type {
  LlmStreamHandlers,
  StreamChatOptions,
  StreamChatStats,
  StreamChatResult,
  StreamChatIterable,
} from './llm-client'
export {
  saveConfig,
  loadConfig,
  clearSession,
  getSessionConfig,
  isSessionUnlocked,
  RuntimeConfigError,
} from './runtime-config'
export type {
  RuntimeLLMConfig,
  PersistedRuntimeConfig,
  PendingConfigView,
} from './runtime-config'
export type {
  ProviderKindString,
  LlmErrorKindString,
  LlmStreamEvent,
  LlmFinalResult,
  LlmForwardArgs,
} from './bridge-types'

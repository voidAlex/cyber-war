/**
 * 服务层 barrel（副作用出口）。
 *
 * 导出 persistence-service / llm-service。
 * 这些服务编排副作用，但 Tauri 调用一律走 @gateway/*。
 *
 * @module layers/application/services
 */

export { persistenceService, createEmptyWorldState } from './persistence-service'
export type { PersistenceService } from './persistence-service'
export {
  llmService,
  createLlmService,
  toLlmCallError,
  hitRate,
  LlmCallError,
  LlmNetworkError,
  LlmApiKeyError,
  LlmServerError,
  LlmTimeoutError,
  LlmDegradedError,
  LlmSchemaError,
} from './llm-service'
export type {
  LlmService,
  CacheStats,
} from './llm-service'

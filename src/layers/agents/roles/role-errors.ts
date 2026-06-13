/**
 * 角色 LLM 调用错误辅助（role-errors.ts）。
 *
 * 把 llm-service 的 typed error 判断收拢一处，供四类 roles 在 LLM 失败时
 * 统一回退（mock 解析 / 规则引擎兜底），避免重复 import 与判断逻辑漂移。
 *
 * @module layers/agents/roles/role-errors
 */

import {
  LlmCallError,
  LlmNetworkError,
  LlmApiKeyError,
  LlmServerError,
  LlmTimeoutError,
  LlmDegradedError,
  LlmSchemaError,
} from '@/layers/application/services/llm-service'

export {
  LlmCallError,
  LlmNetworkError,
  LlmApiKeyError,
  LlmServerError,
  LlmTimeoutError,
  LlmDegradedError,
  LlmSchemaError,
}

/**
 * 是否为 LLM 调用错误（四分类 + degraded + schema 校验失败）。
 *
 * roles 据此判断：LLM 失败 → 回退 mock/规则引擎；非 LLM 错误 → 重新抛出。
 *
 * 注意：用 instanceof 而非 err.name 判断——子类（LlmSchemaError/LlmDegradedError 等）
 * 各自设置了 name 字段，但原型链都继承自 LlmCallError，instanceof 能正确识别。
 */
export function isLlmCallError(err: unknown): err is LlmCallError {
  return err instanceof LlmCallError
}

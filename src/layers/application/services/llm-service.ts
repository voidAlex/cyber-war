/**
 * LLM 服务（llm-service.ts）— 副作用出口。
 *
 * 封装多 Agent 编排对 LLM 的调用，经 @gateway/llm-client 走 Rust 真流式转发。
 * 职责：
 * - 处理 Rust 返回的 `degraded:true`（降级信号 → 前端切规则引擎）。
 * - 处理 `LlmStreamError`/invoke reject（按四分类映射 typed error）。
 * - `streamChatStructured<T>`：流式收集完整文本 → `parseLLMJson<T>` → 返回 T；
 *   校验失败 **throw（绝不伪造）**，由上层规则引擎兜底。
 * - 缓存命中统计：累计 hit/miss tokens，暴露给 Inspector。
 *
 * 错误四分类（network/api_key/llm_error/timeout）由 Rust 侧判定，本服务不再猜。
 *
 * @module layers/application/services/llm-service
 */

import Ajv, { type ValidateFunction } from 'ajv'
import {
  streamChat,
  LlmStreamError,
  type StreamChatOptions,
  type StreamChatResult,
  type StreamChatStats,
} from '@/layers/gateway/llm-client'
import { isAppErrorPayload, type AppErrorPayload } from '@/layers/gateway/tauri-bridge'
import { parseLLMJson, LlmJsonParseError } from '@/layers/agents/protocol/schema'
import type { LlmErrorKindString } from '@/layers/gateway/bridge-types'

// =============================================================================
// typed errors（按四分类 + 降级 + schema 校验失败）
// =============================================================================

/** LLM 调用错误基类（上层据此决定降级/重试/提示） */
export abstract class LlmCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmCallError'
  }
}

/** 网络错误（连接级失败：DNS/连接被拒/TLS） */
export class LlmNetworkError extends LlmCallError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmNetworkError'
  }
}
/** 鉴权错误（HTTP 401/403） */
export class LlmApiKeyError extends LlmCallError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmApiKeyError'
  }
}
/** LLM 服务端错误（其余 4xx/5xx/限流） */
export class LlmServerError extends LlmCallError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmServerError'
  }
}
/** 超时错误 */
export class LlmTimeoutError extends LlmCallError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmTimeoutError'
  }
}
/**
 * 降级信号：Rust 3 次重试均失败（degraded:true）。
 * 上层应切规则引擎兜底（修订点 E：离线可玩降级）。
 */
export class LlmDegradedError extends LlmCallError {
  constructor(message: string) {
    super(message)
    this.name = 'LlmDegradedError'
  }
}
/** 结构化输出校验失败（ajv schema 不过），上层规则引擎兜底（绝不伪造） */
export class LlmSchemaError extends LlmCallError {
  constructor(message: string, readonly rawText: string) {
    super(message)
    this.name = 'LlmSchemaError'
  }
}

/**
 * 把四分类字符串映射为对应的 typed error。
 * 网络类降级（degraded）单独由 LlmDegradedError 处理（stats.degraded=true）。
 */
function kindToTypedError(kind: LlmErrorKindString, message: string): LlmCallError {
  switch (kind) {
    case 'network':
      return new LlmNetworkError(message)
    case 'api_key':
      return new LlmApiKeyError(message)
    case 'llm_error':
      return new LlmServerError(message)
    case 'timeout':
      return new LlmTimeoutError(message)
  }
}

/**
 * 把 invoke reject 的 unknown 错误转成 typed error。
 *
 * 优先识别 Rust AppErrorPayload（type:'llm' 含 kind），其次 LlmStreamError，
 * 最后包成通用 LlmNetworkError（保守归类为网络类，上层可重试）。
 */
export function toLlmCallError(err: unknown): LlmCallError {
  if (err instanceof LlmCallError) return err

  if (err instanceof LlmStreamError) {
    return kindToTypedError(err.kind, err.message)
  }

  if (isAppErrorPayload(err)) {
    const payload = err as AppErrorPayload
    if (payload.type === 'llm') {
      return kindToTypedError(payload.message.kind, payload.message.message)
    }
    // crypto/fs/invalid_arg 类错误归为通用 LlmServerError（非四分类，但属调用链异常）
    return new LlmServerError(
      typeof payload.message === 'string'
        ? payload.message
        : JSON.stringify(payload.message),
    )
  }

  // JSON.parse 失败等
  if (err instanceof LlmJsonParseError) {
    return new LlmSchemaError(err.message, '')
  }

  // 兜底：未知错误保守归网络类
  return new LlmNetworkError(err instanceof Error ? err.message : String(err))
}

// =============================================================================
// 缓存命中统计（累计，供 Inspector）
// =============================================================================

/**
 * 缓存命中统计累加器（会话级，多 Agent 累计）。
 * 暴露给 Agent Inspector 展示总命中率与累计成本。
 */
export interface CacheStats {
  /** 累计缓存命中 token 数 */
  totalHitTokens: number
  /** 累计缓存未命中 token 数 */
  totalMissTokens: number
  /** 累计输入 token 数 */
  totalInputTokens: number
  /** 累计输出 token 数 */
  totalOutputTokens: number
  /** 累计调用次数 */
  callCount: number
  /** 累计降级次数 */
  degradedCount: number
}

/** 计算累计命中率（0..1，无调用时返回 0） */
export function hitRate(stats: CacheStats): number {
  const denom = stats.totalHitTokens + stats.totalMissTokens
  return denom === 0 ? 0 : stats.totalHitTokens / denom
}

// =============================================================================
// LLM 服务接口与默认实现
// =============================================================================

/**
 * LLM 服务接口（供 orchestrator 依赖注入，便于 mock 测试）。
 */
export interface LlmService {
  /**
   * 流式收集完整文本（不解析），返回结果 + 统计。
   * 用于纯文本流（如战报润色）。
   * 错误时抛 typed LlmCallError；degraded 时抛 LlmDegradedError。
   */
  streamText(opts: StreamChatOptions): Promise<StreamChatResult>

  /**
   * 流式收集完整文本 → parseLLMJson<T> → 返回强类型 T。
   * schema 校验失败 **throw（绝不伪造）**，由上层规则引擎兜底。
   *
   * @param opts 流式请求选项
   * @param validate ajv 校验函数（用 compileSchema 或 getAgentValidator 取得）
   * @param ajv 可选 ajv 实例（测试注入）
   */
  streamChatStructured<T>(
    opts: StreamChatOptions,
    validate: ValidateFunction<T>,
    ajv?: Ajv,
  ): Promise<{ data: T; stats: StreamChatStats }>

  /** 获取当前缓存命中统计（供 Inspector） */
  getCacheStats(): CacheStats
  /** 重置统计（新回合开始时） */
  resetCacheStats(): void
}

/**
 * 流式函数依赖签名（可注入：默认用 gateway streamChat，测试可 mock）。
 *
 * 接受 StreamChatOptions，返回「可 await 成 StreamChatResult」的对象
 * （gateway 的 StreamChatHandle 实现 PromiseLike<StreamChatResult>，
 *  mock 可直接返回 Promise<StreamChatResult>）。
 */
export type StreamFn = (
  opts: StreamChatOptions,
) => PromiseLike<StreamChatResult>

/**
 * 默认 LLM 服务实现。
 *
 * 依赖注入：注入 streamChat（默认用 gateway 实现，测试可 mock）。
 */
export function createLlmService(
  deps: { stream?: StreamFn } = {},
): LlmService {
  const _stream = deps.stream ?? streamChat

  let stats: CacheStats = {
    totalHitTokens: 0,
    totalMissTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    degradedCount: 0,
  }

  function accumulate(s: StreamChatStats): void {
    stats.totalHitTokens += s.promptCacheHitTokens
    stats.totalMissTokens += s.promptCacheMissTokens
    stats.totalInputTokens += s.inputTokens
    stats.totalOutputTokens += s.outputTokens
    stats.callCount += 1
    if (s.degraded) stats.degradedCount += 1
  }

  return {
    async streamText(opts: StreamChatOptions): Promise<StreamChatResult> {
      let result: StreamChatResult
      try {
        result = await _stream(opts)
      } catch (err) {
        throw toLlmCallError(err)
      }
      accumulate(result.stats)
      // 降级信号：Rust 3 次重试均失败 → 切规则引擎
      if (result.stats.degraded) {
        throw new LlmDegradedError(
          'LLM 3 次重试均失败，切规则引擎兜底（degraded:true）',
        )
      }
      return result
    },

    async streamChatStructured<T>(
      opts: StreamChatOptions,
      validate: ValidateFunction<T>,
      _ajv?: Ajv,
    ): Promise<{ data: T; stats: StreamChatStats }> {
      let result: StreamChatResult
      try {
        result = await _stream(opts)
      } catch (err) {
        throw toLlmCallError(err)
      }
      accumulate(result.stats)
      if (result.stats.degraded) {
        throw new LlmDegradedError(
          'LLM 3 次重试均失败，切规则引擎兜底（degraded:true）',
        )
      }

      // 流式收集完整文本 → parseLLMJson（剥离 fence + ajv 校验）
      let data: T
      try {
        data = parseLLMJson<T>(result.text, validate)
      } catch (err) {
        // 校验失败：绝不伪造，抛 LlmSchemaError 让上层规则引擎兜底
        const raw = result.text
        if (err instanceof LlmJsonParseError) {
          throw new LlmSchemaError(err.message, raw)
        }
        throw new LlmSchemaError(
          err instanceof Error ? err.message : String(err),
          raw,
        )
      }

      return { data, stats: result.stats }
    },

    getCacheStats(): CacheStats {
      return { ...stats }
    },

    resetCacheStats(): void {
      stats = {
        totalHitTokens: 0,
        totalMissTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        callCount: 0,
        degradedCount: 0,
      }
    },
  }
}

/**
 * 默认单例 LLM 服务（经 gateway 走真实 Rust 流式转发）。
 * orchestrator 通过依赖注入持有；测试可注入 mock。
 */
export const llmService: LlmService = createLlmService()

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
import { appendDiagnostic, type DiagnosticEntry } from '@/layers/persistence/diagnostics'

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
 * 面向 UI 的四分类错误横幅（与 llm-service 四分类对齐）。
 * 定义在此（叶子模块）以避免与 store 循环依赖。
 */
export type LlmErrorBanner =
  | { kind: 'api_key'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'degraded'; message: string }
  | { kind: 'schema'; message: string }
  | { kind: 'server'; message: string }

/**
 * 把 typed LlmCallError 映射为面向 UI 的四分类横幅信息（ErrorBanner 用）。
 *
 * 对应重写计划「错误四分类提示」与审计教训「绝不把 ApiKey 失效误报为网络中断」：
 * - LlmApiKeyError → "API Key 失效，请检查密钥"
 * - LlmTimeoutError → "请求超时，已重试/降级"
 * - LlmNetworkError → "网络异常，状态已保存"
 * - LlmDegradedError → "本回合降级结算（规则引擎）"
 * - LlmSchemaError → "AI 输出格式异常，已兜底"
 * - LlmServerError → 通用服务端错误
 *
 * @param err LlmCallError（或任意值；非 LlmCallError 归 server）
 * @returns 四分类横幅信息（kind + 用户可读 message）
 */
export function errorToBanner(err: unknown): LlmErrorBanner {
  if (err instanceof LlmApiKeyError) {
    return { kind: 'api_key', message: 'API Key 失效，请检查密钥' }
  }
  if (err instanceof LlmTimeoutError) {
    return { kind: 'timeout', message: '请求超时，已重试/降级' }
  }
  if (err instanceof LlmNetworkError) {
    return { kind: 'network', message: '网络异常，状态已保存' }
  }
  if (err instanceof LlmDegradedError) {
    return { kind: 'degraded', message: '本回合降级结算（规则引擎）' }
  }
  if (err instanceof LlmSchemaError) {
    return { kind: 'schema', message: 'AI 输出格式异常，已兜底' }
  }
  return {
    kind: 'server',
    message: err instanceof Error ? err.message : String(err),
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

/**
 * 把 typed LlmCallError 映射为诊断条目的 category（点分 `llm/<kind>`）。
 *
 * 用于错误分类路径落 diagnostics.log（P2-2）：
 * - LlmNetworkError → `llm/network`
 * - LlmApiKeyError → `llm/api_key`
 * - LlmServerError → `llm/llm_error`
 * - LlmTimeoutError → `llm/timeout`
 * - LlmDegradedError → `llm/degraded`
 * - LlmSchemaError → `llm/schema`
 * 非 LlmCallError 归 `llm/unknown`。
 */
function llmErrorCategory(err: unknown): string {
  if (err instanceof LlmNetworkError) return 'llm/network'
  if (err instanceof LlmApiKeyError) return 'llm/api_key'
  if (err instanceof LlmServerError) return 'llm/llm_error'
  if (err instanceof LlmTimeoutError) return 'llm/timeout'
  if (err instanceof LlmDegradedError) return 'llm/degraded'
  if (err instanceof LlmSchemaError) return 'llm/schema'
  return 'llm/unknown'
}

/**
 * 把 typed LlmCallError 落一条诊断（category=llm/<kind>，level=error）。
 *
 * 仅落概要 message（diagnostics 内部还会兜底脱敏，绝不写 key/payload）。
 * code 取 HTTP status 时由调用方经 err.message 透传，此处只取 message 文本。
 * 落盘失败静默吞掉（诊断不得打断主流程）。
 */
async function appendLlmDiagnostic(
  diagnosticSink: DiagnosticSink | undefined,
  err: unknown,
): Promise<void> {
  if (!diagnosticSink) return
  const entry: DiagnosticEntry = {
    level: 'error',
    category: llmErrorCategory(err),
    message: err instanceof Error ? err.message : String(err),
  }
  try {
    await diagnosticSink.append(diagnosticSink.saveId, entry)
  } catch {
    // 诊断落盘失败不得打断 LLM 调用主流程
  }
}

/**
 * 诊断下沉（依赖注入）：由编排器/上层注入，决定落哪个存档的 diagnostics.log。
 * 默认单例 llmService 不注入（无副作用）；M3+ 由编排器注入 saveId + appendDiagnostic。
 */
export interface DiagnosticSink {
  /** 目标存档 id（决定 diagnostics.log 路径） */
  saveId: string
  /** 追加函数（默认指向 diagnostics.appendDiagnostic，测试可 mock） */
  append: (saveId: string, entry: DiagnosticEntry) => Promise<void>
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

  /**
   * 增量回调式流式：消费 delta 事件（边出边显示，TTFT<200ms 目标），
   * 同时累计 hit/miss/降级统计，最终返回完整文本。
   *
   * 用于导演部战报真流式：onDelta 在每个 text 片段到达时回调。
   * 错误时抛 typed LlmCallError；degraded 时抛 LlmDegradedError。
   *
   * @param opts 流式请求选项
   * @param onDelta 每个文本片段的回调（可选）
   */
  streamTextWithDeltas(
    opts: StreamChatOptions,
    onDelta?: (chunk: string) => void,
  ): Promise<StreamChatResult>

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
 * 可选注入 `diagnosticSink`：错误分类路径落 diagnostics.log（P2-2）。
 */
export function createLlmService(
  deps: { stream?: StreamFn; diagnosticSink?: DiagnosticSink } = {},
): LlmService {
  const _stream = deps.stream ?? streamChat
  const _diagnosticSink = deps.diagnosticSink

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
        const typed = toLlmCallError(err)
        // P2-2：错误分类路径落 diagnostics.log（仅概要，绝不写 key/payload）
        await appendLlmDiagnostic(_diagnosticSink, typed)
        throw typed
      }
      accumulate(result.stats)
      // 降级信号：Rust 3 次重试均失败 → 切规则引擎
      if (result.stats.degraded) {
        const degradedErr = new LlmDegradedError(
          'LLM 3 次重试均失败，切规则引擎兜底（degraded:true）',
        )
        await appendLlmDiagnostic(_diagnosticSink, degradedErr)
        throw degradedErr
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
        const typed = toLlmCallError(err)
        await appendLlmDiagnostic(_diagnosticSink, typed)
        throw typed
      }
      accumulate(result.stats)
      if (result.stats.degraded) {
        const degradedErr = new LlmDegradedError(
          'LLM 3 次重试均失败，切规则引擎兜底（degraded:true）',
        )
        await appendLlmDiagnostic(_diagnosticSink, degradedErr)
        throw degradedErr
      }

      // 流式收集完整文本 → parseLLMJson（剥离 fence + ajv 校验）
      let data: T
      try {
        data = parseLLMJson<T>(result.text, validate)
      } catch (err) {
        // 校验失败：绝不伪造，抛 LlmSchemaError 让上层规则引擎兜底
        const raw = result.text
        const schemaErr = err instanceof LlmJsonParseError
          ? new LlmSchemaError(err.message, raw)
          : new LlmSchemaError(
              err instanceof Error ? err.message : String(err),
              raw,
            )
        await appendLlmDiagnostic(_diagnosticSink, schemaErr)
        throw schemaErr
      }

      return { data, stats: result.stats }
    },

    getCacheStats(): CacheStats {
      return { ...stats }
    },

    async streamTextWithDeltas(
      opts: StreamChatOptions,
      onDelta?: (chunk: string) => void,
    ): Promise<StreamChatResult> {
      // 若注入了 stream（测试 mock），无可迭代器，回退到 streamText（无 delta 回调）。
      if (deps.stream) {
        return this.streamText(opts)
      }
      // 默认：直接消费 gateway streamChat 的 AsyncIterable（真流式 delta）。
      const handle = streamChat(opts)
      try {
        for await (const evt of handle) {
          if (evt.type === 'delta' && onDelta) {
            onDelta(evt.text)
          }
        }
      } catch (err) {
        const typed = toLlmCallError(err)
        await appendLlmDiagnostic(_diagnosticSink, typed)
        throw typed
      }
      let result: StreamChatResult
      try {
        result = await handle.result()
      } catch (err) {
        const typed = toLlmCallError(err)
        await appendLlmDiagnostic(_diagnosticSink, typed)
        throw typed
      }
      accumulate(result.stats)
      if (result.stats.degraded) {
        const degradedErr = new LlmDegradedError(
          'LLM 3 次重试均失败，切规则引擎兜底（degraded:true）',
        )
        await appendLlmDiagnostic(_diagnosticSink, degradedErr)
        throw degradedErr
      }
      return result
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
 *
 * 默认单例**不**绑定 saveId，故不落 diagnostics（无目标存档）；
 * 需要落诊断时用 [`createLlmServiceWithDiagnostics`] 按 saveId 构造实例。
 */
export const llmService: LlmService = createLlmService()

/**
 * 构造一个绑定 saveId、错误路径落 diagnostics.log 的 LLM 服务（P2-2）。
 *
 * 在四分类错误/降级/schema 失败时自动追加一条诊断（category=llm/<kind>，
 * level=error，仅概要 message，绝不写 key/payload）。落盘失败静默吞掉。
 *
 * 供编排器/上层在进入某存档上下文时按 saveId 创建实例。
 *
 * @param saveId 目标存档 id（决定 diagnostics.log 路径）
 * @param overrides 可选覆盖（如注入 mock stream 做测试）
 */
export function createLlmServiceWithDiagnostics(
  saveId: string,
  overrides: { stream?: StreamFn } = {},
): LlmService {
  return createLlmService({
    stream: overrides.stream,
    diagnosticSink: { saveId, append: appendDiagnostic },
  })
}

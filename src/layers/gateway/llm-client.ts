/**
 * LLM 客户端（llm-client.ts）— 唯一 import `@tauri-apps/api` 的层。
 *
 * 封装 `llm_stream_forward` 的 Channel 订阅：前端创建 Channel，订阅 onmessage
 * 接收 LlmStreamEvent（delta/usage/done/error），Rust reqwest 真流式透传。
 *
 * 提供两种消费 API：
 * - `streamChat(opts): AsyncIterable<LlmStreamEvent>`（推荐，M3 主用）：
 *   把 Rust Channel 事件流转成 AsyncIterable，便于 `for await` 消费；
 *   从 usage 事件提取命中率统计，随结果返回。
 * - `streamForward(args, handlers)`（回调式，M1 保留兼容）：直接传回调。
 *
 * 安全：endpoint 经 Rust guard 校验（白名单 + 私网拒绝 + 生产 https）；
 * api_key 仅作参数透传，绝不写日志；payload 不解析游戏语义。
 * 错误四分类由 Rust 侧判定，前端不再猜。
 *
 * @module layers/gateway/llm-client
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  LlmForwardArgs,
  LlmFinalResult,
  LlmStreamEvent,
  LlmErrorKindString,
  ProviderKindString,
} from './bridge-types'
// web 模式降级：isWebMode() 为 true 时改走 web-mock-llm（经 vite proxy 真调 DeepSeek）。
// 不破坏 Tauri 生产路径（false 时完全走原 invoke）与 vitest（jsdom 下 false）。
import { isWebMode } from './web-mode'
import { webStreamForward } from './web-mock-llm'

// =============================================================================
// 共享类型：流式结果（含命中率统计）
// =============================================================================

/**
 * 单次流式调用的统计结果（从 Rust LlmFinalResult + 流中 usage 事件汇总）。
 * 多 Agent 编排累计后供 Inspector 展示命中率/成本。
 */
export interface StreamChatStats {
  /** 缓存命中 token 数（DeepSeek prompt_cache_hit_tokens） */
  promptCacheHitTokens: number
  /** 缓存未命中 token 数 */
  promptCacheMissTokens: number
  /** 输入 token 数（通用） */
  inputTokens: number
  /** 输出 token 数（通用） */
  outputTokens: number
  /** 是否降级（Rust 3 次重试均失败，前端切规则引擎） */
  degraded: boolean
}

/**
 * streamChat 的最终结果。
 * 含完整文本（已拼接所有 delta）与命中率统计。
 */
export interface StreamChatResult {
  /** 累积的完整文本（所有 delta 拼接） */
  text: string
  /** 统计信息（命中率/降级标志） */
  stats: StreamChatStats
}

// =============================================================================
// 回调式 API（M1 保留兼容）
// =============================================================================

/**
 * 流式消费回调集合。
 * @deprecated 优先用 streamChat（AsyncIterable）。保留以兼容旧调用方。
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
  onError?: (kind: LlmErrorKindString, message: string) => void
}

/**
 * 发起一次真流式 LLM 转发（回调式，订阅 Channel 接收流式事件）。
 *
 * @param args 转发参数（provider/endpoint/apiKey/payload）
 * @param handlers 流式事件回调
 * @returns 最终结果（含 degraded 标志，前端据此切规则引擎）
 */
export async function streamForward(
  args: LlmForwardArgs,
  handlers: LlmStreamHandlers,
): Promise<LlmFinalResult> {
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
        handlers.onError?.(event.kind, event.message)
        break
    }
  }

  // 注意：invoke 参数名必须与 commands.rs #[tauri::command] 的参数名严格一致。
  const result = await invoke<LlmFinalResult>('llm_stream_forward', {
    provider: args.provider,
    endpoint: args.endpoint,
    apiKey: args.apiKey,
    payload: args.payload,
    onEvent: channel,
  })
  return result
}

// =============================================================================
// AsyncIterable API（M3 主用）
// =============================================================================

/**
 * streamChat 的输入选项（OpenAI/DeepSeek 兼容 chat 格式友好）。
 */
export interface StreamChatOptions {
  /** provider 标识（deepseek/openai/anthropic/custom） */
  provider: ProviderKindString
  /** 目标 endpoint URL（完整 chat/completions 路径，Rust router 校验白名单） */
  endpoint: string
  /** API key（即用即抛，不缓存） */
  apiKey: string
  /** 模型名（如 deepseek-v4-flash） */
  model: string
  /** messages 数组（OpenAI/DeepSeek 兼容格式） */
  messages: Array<{ role: string; content: string }>
  /** 思考模式（DeepSeek thinking:{type:"enabled"} 等，可选） */
  thinking?: Record<string, unknown>
  /** 温度等额外参数（透传，可选） */
  extraParams?: Record<string, unknown>
  /**
   * 取消信号（可选）。
   *
   * 注意：Tauri invoke 当前不支持运行中取消，abort 仅会让迭代器提前 return
   * （底层 Rust 流可能仍在后台跑完，但前端不再消费）。真正的请求取消
   * 待 Tauri 提供 invoke cancel 能力后补全。
   */
  signal?: AbortSignal
}

/**
 * 流式迭代器接口（AsyncIterable + 最终结果 Promise）。
 */
export interface StreamChatIterable extends AsyncIterable<LlmStreamEvent> {
  /**
   * 获取最终结果（含完整文本与命中率统计）。
   * 等价于 await streamChat(opts)。
   */
  result(): Promise<StreamChatResult>
}

/**
 * 发起一次真流式 LLM 转发，返回流式对象（既是 AsyncIterable 又是 Promise）。
 *
 * 用法 A（for await + result）：
 * ```ts
 * const stream = streamChat(opts)
 * for await (const event of stream) {
 *   if (event.type === 'delta') appendText(event.text)
 *   if (event.type === 'usage') recordHitRate(event)
 * }
 * const { text, stats } = await stream.result()
 * ```
 *
 * 用法 B（纯 await，仅取最终文本，不消费流）：
 * ```ts
 * const { text, stats } = await streamChat(opts)
 * ```
 *
 * error 事件以 throw 形式终止迭代（调用方 try/catch 收拢为 typed error）。
 *
 * @param opts 流式请求选项
 */
export function streamChat(opts: StreamChatOptions): StreamChatHandle {
  return new StreamChatHandle(opts)
}

/**
 * streamChat 返回的流式句柄。
 *
 * 同时实现 AsyncIterable<LlmStreamEvent>（可 for await）与
 * PromiseLike<StreamChatResult>（可直接 await）。
 */
export class StreamChatHandle
  implements StreamChatIterable, PromiseLike<StreamChatResult>
{
  private readonly opts: StreamChatOptions
  /** 缓冲的事件队列（Channel onmessage 推入，迭代器 pull 消费） */
  private queue: LlmStreamEvent[] = []
  /** 等待消费者拉取的 resolve（队列空且未终结时挂起迭代器） */
  private pendingResolve:
    | ((r: IteratorResult<LlmStreamEvent>) => void)
    | null = null
  /** 等待消费者拉取的 reject（仅错误终结时用于 reject next() Promise） */
  private pendingReject: ((e: unknown) => void) | null = null
  /** 流事件是否已终结（done/error/abort 之一已发生） */
  private streamDone = false
  /** 错误（Rust emit error 事件或 invoke reject）；非 null 时迭代器 throw */
  private error: unknown = null
  /** resultPromise 是否已 resolve/reject（防重复结算） */
  private resultResolved = false
  /** 累积的完整文本 */
  private accumulatedText = ''
  /** 流中观测到的 usage（Rust emit 的 usage 事件） */
  private observedUsage: {
    promptCacheHitTokens: number | null
    promptCacheMissTokens: number | null
    inputTokens: number | null
    outputTokens: number | null
  } | null = null
  /** Rust invoke 返回的最终结果（degraded 标志 + 兜底 usage） */
  private finalResult: LlmFinalResult | null = null
  /** 整体结果 Promise（await streamChat(opts) 即得 StreamChatResult） */
  private readonly resultPromise: Promise<StreamChatResult>
  private resultResolve!: (r: StreamChatResult) => void
  private resultReject!: (e: unknown) => void
  /** 是否已启动 invoke（懒启动：首次 next()/await 时才发请求） */
  private started = false
  /** abort 监听器引用（便于移除） */
  private abortListener: (() => void) | null = null

  constructor(opts: StreamChatOptions) {
    this.opts = opts
    this.resultPromise = new Promise<StreamChatResult>((resolve, reject) => {
      this.resultResolve = resolve
      this.resultReject = reject
    })
    // 防 unhandled rejection：句柄可能被「只消费迭代器、不 await result()」的调用方
    // 使用。此处附加 noop catch 兜底，真正的消费者经 then() 仍能收到 rejection
    // （同一 promise 可挂多个 handler）。调用方应自行 try/catch 处理错误。
    this.resultPromise.catch(() => {})
  }

  /** 启动 invoke（懒启动，幂等） */
  private start(): void {
    if (this.started) return
    this.started = true

    // 订阅 abort
    if (this.opts.signal) {
      if (this.opts.signal.aborted) {
        this.handleAbort()
      } else {
        this.abortListener = () => this.handleAbort()
        this.opts.signal.addEventListener('abort', this.abortListener)
      }
    }

    // === web 模式分支：经 vite proxy 真调 DeepSeek，事件经 handleEvent 复用同一模型 ===
    if (isWebMode()) {
      // webStreamForward 内部已推送 done/error 事件并返回 finalResult（含 degraded）
      webStreamForward(
        this.opts,
        (event) => this.handleEvent(event),
        this.opts.signal,
      )
        .then((result) => {
          this.finalResult = result
          this.maybeResolveResult()
        })
        .catch((err: unknown) => {
          // abort 抛 AbortError 时流可能已部分交付，setError 内部会兜底
          this.setError(err)
        })
      return
    }

    // === Tauri 模式（生产 + vitest）：原 invoke 路径，行为不变 ===

    // 构造 payload（OpenAI/DeepSeek 兼容 chat 格式）
    const payload: Record<string, unknown> = {
      model: this.opts.model,
      messages: this.opts.messages,
      stream: true,
    }
    if (this.opts.thinking) payload.thinking = this.opts.thinking
    if (this.opts.extraParams) Object.assign(payload, this.opts.extraParams)

    // 创建 Channel 订阅 Rust emit 的事件
    const channel = new Channel<LlmStreamEvent>()
    channel.onmessage = (event) => this.handleEvent(event)

    // 发起 invoke（参数名对齐 commands.rs）
    invoke<LlmFinalResult>('llm_stream_forward', {
      provider: this.opts.provider,
      endpoint: this.opts.endpoint,
      apiKey: this.opts.apiKey,
      payload,
      onEvent: channel,
    })
      .then((result) => {
        this.finalResult = result
        // invoke 成功返回（finalResult 就绪）：若流也已 Done/abort，则 resolve
        this.maybeResolveResult()
      })
      .catch((err: unknown) => {
        // invoke reject（Rust 返回 Err）：转 throw
        this.setError(err)
      })
  }

  /** 处理单个 Rust 事件 */
  private handleEvent(event: LlmStreamEvent): void {
    if (this.streamDone) return // 已终结（如已 abort），丢弃后续事件

    switch (event.type) {
      case 'delta':
        this.accumulatedText += event.text
        this.deliver(event)
        break
      case 'usage':
        this.observedUsage = {
          promptCacheHitTokens: event.promptCacheHitTokens,
          promptCacheMissTokens: event.promptCacheMissTokens,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        }
        this.deliver(event)
        break
      case 'done':
        this.deliver(event)
        this.settleDone()
        break
      case 'error':
        this.deliver(event) // 让消费方在 throw 前也能看到 error 事件
        this.setError(this.makeError(event))
        break
    }
  }

  /** 把事件交付给等待的迭代器，或入队 */
  private deliver(event: LlmStreamEvent): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve
      this.pendingResolve = null
      this.pendingReject = null
      resolve({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
  }

  /** 唤醒挂起的迭代器（返回 done=true） */
  private wakeIteratorDone(): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve
      this.pendingResolve = null
      this.pendingReject = null
      resolve({ value: undefined, done: true })
    }
  }

  /** 唤醒挂起的迭代器（reject，触发 for-await throw） */
  private wakeIteratorError(): void {
    if (this.pendingReject) {
      const reject = this.pendingReject
      this.pendingResolve = null
      this.pendingReject = null
      reject(this.error)
    }
  }

  /** 处理 abort：迭代器提前 return（不消费剩余事件，不算错误） */
  private handleAbort(): void {
    if (this.streamDone) return
    this.streamDone = true
    this.cleanupAbortListener()
    this.wakeIteratorDone()
    // abort 不等 finalResult，立即用已累积文本 resolve
    this.maybeResolveResult(/* allowPartial */ true)
  }

  /** 标记流正常终结（Done 事件） */
  private settleDone(): void {
    if (this.streamDone) return
    this.streamDone = true
    this.cleanupAbortListener()
    this.wakeIteratorDone()
    // Done 后等 finalResult 到达再 resolve（maybeResolveResult 内部判空）
    this.maybeResolveResult()
  }

  /** 处理错误（error 事件或 invoke reject） */
  private setError(err: unknown): void {
    if (this.resultResolved) {
      // 已结算：仅 reject（防重复）。但 promise 已 settle，此 reject 无副作用。
      return
    }
    this.error = err
    this.streamDone = true
    this.resultResolved = true
    this.cleanupAbortListener()
    this.wakeIteratorError()
    this.resultReject(err)
  }

  private cleanupAbortListener(): void {
    if (this.abortListener && this.opts.signal) {
      this.opts.signal.removeEventListener('abort', this.abortListener)
      this.abortListener = null
    }
  }

  /** 把 stream error 事件转成 typed error */
  private makeError(
    event: Extract<LlmStreamEvent, { type: 'error' }>,
  ): LlmStreamError {
    return new LlmStreamError(event.kind, event.message)
  }

  /**
   * 计算 StreamChatResult 并 resolve resultPromise。
   *
   * 结算条件（防过早/重复 resolve）：
   * - 已 resultResolved：直接返回（幂等）。
   * - abort（allowPartial=true）：立即用已累积文本 resolve（不等 finalResult）。
   * - Done：需 streamDone 且 finalResult 已到达（invoke 返回含 degraded 标志）。
   *
   * @param allowPartial abort 场景允许在 finalResult 到达前用部分文本 resolve
   */
  private maybeResolveResult(allowPartial = false): void {
    if (this.resultResolved) return
    // Done 场景：必须等 finalResult 到达才能读 degraded 标志
    if (!allowPartial && this.finalResult === null) return
    // Done 场景：必须流已结束
    if (!allowPartial && !this.streamDone) return

    const usage = this.observedUsage
    const hit =
      usage?.promptCacheHitTokens ?? this.finalResult?.promptCacheHitTokens ?? null
    const miss =
      usage?.promptCacheMissTokens ?? this.finalResult?.promptCacheMissTokens ?? null
    const inputTokens =
      usage?.inputTokens ?? this.finalResult?.inputTokens ?? null
    const outputTokens =
      usage?.outputTokens ?? this.finalResult?.outputTokens ?? null

    const stats: StreamChatStats = {
      promptCacheHitTokens: hit ?? 0,
      promptCacheMissTokens: miss ?? 0,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      degraded: this.finalResult?.degraded ?? false,
    }

    this.resultResolved = true
    this.resultResolve({ text: this.accumulatedText, stats })
  }

  // === AsyncIterable 实现 ===
  [Symbol.asyncIterator](): AsyncIterator<LlmStreamEvent> {
    return {
      next: (): Promise<IteratorResult<LlmStreamEvent>> => this.next(),
    }
  }

  /** 迭代器 next 实现 */
  private next(): Promise<IteratorResult<LlmStreamEvent>> {
    this.start() // 懒启动

    // 已有错误：reject（让 for-await throw）
    if (this.error !== null) {
      return Promise.reject(this.error)
    }

    // 队列有事件：立即返回
    if (this.queue.length > 0) {
      const event = this.queue.shift() as LlmStreamEvent
      return Promise.resolve({ value: event, done: false })
    }

    // 已终结（无错误）：返回 done
    if (this.streamDone) {
      return Promise.resolve({ value: undefined, done: true })
    }

    // 挂起等待
    return new Promise<IteratorResult<LlmStreamEvent>>((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject
    })
  }

  // === PromiseLike<StreamChatResult> 实现（可直接 await） ===
  then<TResult1 = StreamChatResult, TResult2 = never>(
    onfulfilled?:
      | ((value: StreamChatResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    this.start()
    return this.resultPromise.then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null,
  ): Promise<StreamChatResult | TResult> {
    this.start()
    return this.resultPromise.catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<StreamChatResult> {
    this.start()
    return this.resultPromise.finally(onfinally)
  }

  result(): Promise<StreamChatResult> {
    this.start()
    return this.resultPromise
  }
}

// =============================================================================
// typed error：LLM 流式错误（带四分类 kind）
// =============================================================================

/**
 * LLM 流式错误（带四分类 kind）。
 *
 * 由 Rust emit 的 error 事件或 invoke reject 触发。
 * kind: network/api_key/llm_error/timeout（对齐 error.rs LlmErrorKind.as_str()）。
 * 上层 llm-service 据此映射为对应的 typed error，决定降级策略。
 */
export class LlmStreamError extends Error {
  constructor(
    readonly kind: LlmErrorKindString,
    message: string,
  ) {
    super(`[${kind}] ${message}`)
    this.name = 'LlmStreamError'
  }
}

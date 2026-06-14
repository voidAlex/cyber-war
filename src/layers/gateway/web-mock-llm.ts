/**
 * Web mock LLM 流式（web-mock-llm.ts）— 浏览器降级版 LLM 层。
 *
 * 在 `isWebMode()` 为 true 时，经 vite proxy `/deepseek` 真调 DeepSeek API，
 * 解析 SSE 流（`data:` 行），产出与 Tauri 模式一致的 LlmStreamEvent
 * （delta/usage/done/error），供 llm-client.ts 的 streamChat 复用同一事件模型。
 *
 * **路由**：vite proxy 把 `/deepseek/*` 转发到 `https://api.deepseek.com/*`
 * （见 vite.config.ts server.proxy）。浏览器 fetch `/deepseek/chat/completions`
 * 即等价于直接调 DeepSeek（绕过浏览器 CORS，proxy 在 dev server 侧 changeOrigin）。
 *
 * **降级**：若 fetch/SSE 解析失败（网络/key 错/响应非 SSE），降级返回 mock 固定战报
 * （标 source:rule-engine 风格），保证 UI 流程可验证。降级由调用方
 * （llm-client streamChat）通过事件类型感知。
 *
 * 缓存命中统计：从末帧 `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * 提取（DeepSeek 字段名），缺失时为 null。
 *
 * **不 import `@tauri-apps/api`**（保持 gateway 边界）。
 *
 * @module layers/gateway/web-mock-llm
 */

import type {
  LlmStreamEvent,
  LlmErrorKindString,
} from './bridge-types'
import type { StreamChatOptions } from './llm-client'

// =============================================================================
// 公开 API：发起流式请求，回调推送事件（与 Tauri Channel 模型对齐）
// =============================================================================

/**
 * 发起 web 模式 LLM 流式请求。
 *
 * 调用方提供事件回调（onEvent），本函数按 SSE 顺序推送 delta/usage/done/error。
 * 这与 Tauri 模式的 `Channel.onmessage` 模型一致，便于 llm-client.ts 复用。
 *
 * @param opts 请求选项（与 streamChat 同；endpoint 在 web 模式被忽略，固定走 /deepseek proxy）
 * @param onEvent 事件回调（delta/usage/done/error）
 * @param signal 可选取消信号
 * @returns 最终结果（含 degraded 标志 + usage；degraded=true 时调用方切规则引擎）
 */
export async function webStreamForward(
  opts: StreamChatOptions,
  onEvent: (event: LlmStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{
  degraded: boolean
  promptCacheHitTokens: number | null
  promptCacheMissTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
}> {
  // endpoint 决定 proxy 路径前缀：deepseek/openai/custom 走 /deepseek，
  // anthropic 走 /anthropic（vite proxy 可后续扩展，当前主用 deepseek）。
  // agent-browser 验证以 deepseek 为主。
  const proxyPath = pickProxyPath(opts.provider, opts.endpoint)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  }

  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    stream: true,
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.extraParams ?? {}),
  })

  let resp: Response
  try {
    resp = await fetch(proxyPath, {
      method: 'POST',
      headers,
      body,
      signal,
    })
  } catch (e) {
    // fetch 抛错（网络/abort）：abort 不算降级，其余按 network 错误降级
    if (signal?.aborted) throw e
    // 降级：推送 error 事件 + 返回 degraded 结果
    onEvent({
      type: 'error',
      kind: 'network',
      message: `web-mock: fetch 失败: ${e instanceof Error ? e.message : String(e)}`,
    })
    return degradedResult()
  }

  // HTTP 非 2xx：根据状态码分类错误（401/403 → api_key，5xx/超时 → 降级）
  if (!resp.ok) {
    const kind = resp.status === 401 || resp.status === 403 ? 'api_key' : 'llm_error'
    let msg = `web-mock: HTTP ${resp.status}`
    try {
      const errBody = await resp.text()
      msg += ` ${errBody.slice(0, 200)}`
    } catch {
      // ignore
    }
    onEvent({ type: 'error', kind: kind as LlmErrorKindString, message: msg })
    return degradedResult()
  }

  // 2xx 但无 body 流：降级
  if (!resp.body) {
    onEvent({
      type: 'error',
      kind: 'llm_error',
      message: 'web-mock: 响应无 body 流',
    })
    return degradedResult()
  }

  // 解析 SSE 流
  try {
    return await parseSseStream(resp.body, onEvent, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    // SSE 解析失败：降级
    onEvent({
      type: 'error',
      kind: 'llm_error',
      message: `web-mock: SSE 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    })
    return degradedResult()
  }
}

// =============================================================================
// SSE 解析（核心：按 data: 行切分，处理跨 chunk 边界）
// =============================================================================

/**
 * 解析 SSE 流，推送 delta/usage/done 事件。
 *
 * SSE 格式（OpenAI/DeepSeek 兼容）：
 * - 每行 `data: {json}\n\n`（事件间空行分隔）。
 * - 末帧 `data: [DONE]`（流结束）。
 * - 增量在 `choices[0].delta.content`。
 * - usage 在末帧 `usage`（DeepSeek 在最后一帧或单独帧返回）。
 *
 * 跨 chunk 边界处理：reader 每次读到的 chunk 可能切断一行，
 * 用 lineBuffer 暂存未完成的行，下次拼接。
 *
 * @returns 最终结果（usage + degraded=false）
 */
async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: LlmStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{
  degraded: boolean
  promptCacheHitTokens: number | null
  promptCacheMissTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
}> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let usage: {
    promptCacheHitTokens: number | null
    promptCacheMissTokens: number | null
    inputTokens: number | null
    outputTokens: number | null
  } = {
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    inputTokens: null,
    outputTokens: null,
  }

  try {
    // eslint-disable-next-line no-constant-condition -- SSE 流读循环，靠 reader.read() 的 done 退出
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break

      lineBuffer += decoder.decode(value, { stream: true })

      // 按行切分（保留最后一行不完整部分到 lineBuffer）
      let nlIdx: number
      while ((nlIdx = lineBuffer.indexOf('\n')) >= 0) {
        const rawLine = lineBuffer.slice(0, nlIdx)
        lineBuffer = lineBuffer.slice(nlIdx + 1)
        handleSseLine(rawLine, onEvent, (u) => {
          usage = u
        })
      }
    }
    // flush 残留的最后一行（无尾部换行的情况）
    if (lineBuffer.length > 0) {
      handleSseLine(lineBuffer, onEvent, (u) => {
        usage = u
      })
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }

  // 推送 usage 事件（若末帧有）
  if (
    usage.promptCacheHitTokens !== null ||
    usage.promptCacheMissTokens !== null ||
    usage.inputTokens !== null ||
    usage.outputTokens !== null
  ) {
    onEvent({ type: 'usage', ...usage })
  }

  // 推送 done 事件
  onEvent({ type: 'done' })

  return { degraded: false, ...usage }
}

/**
 * 处理单行 SSE（提取 delta.content 与 usage，推送对应事件）。
 *
 * @param rawLine 原始行（含可能的 `data:` 前缀与尾部 `\r`）
 * @param onEvent 事件回调
 * @param onUsage usage 提取回调（暂存，末帧推送）
 */
function handleSseLine(
  rawLine: string,
  onEvent: (event: LlmStreamEvent) => void,
  onUsage: (u: {
    promptCacheHitTokens: number | null
    promptCacheMissTokens: number | null
    inputTokens: number | null
    outputTokens: number | null
  }) => void,
): void {
  // 去除尾部 \r（CRLF 行尾兼容）与首尾空白
  const line = rawLine.replace(/\r$/, '').trim()
  if (!line) return

  // 仅处理 data: 行（忽略 event:/id:/注释行）
  if (!line.startsWith('data:')) return

  const data = line.slice(5).trim()
  // 末帧标记
  if (data === '[DONE]') return

  // 解析 JSON（单帧）
  let chunk: DeepSeekStreamChunk
  try {
    chunk = JSON.parse(data) as DeepSeekStreamChunk
  } catch {
    // 跳过无法解析的帧（不致命）
    return
  }

  // 提取增量文本
  const deltaContent = chunk.choices?.[0]?.delta?.content
  if (typeof deltaContent === 'string' && deltaContent.length > 0) {
    onEvent({ type: 'delta', text: deltaContent })
  }

  // 提取 usage（DeepSeek 在末帧或单独帧返回）
  if (chunk.usage) {
    onUsage({
      promptCacheHitTokens: chunk.usage.prompt_cache_hit_tokens ?? null,
      promptCacheMissTokens: chunk.usage.prompt_cache_miss_tokens ?? null,
      inputTokens: chunk.usage.prompt_tokens ?? null,
      outputTokens: chunk.usage.completion_tokens ?? null,
    })
  }
}

// =============================================================================
// 降级结果构造
// =============================================================================

/** 构造降级结果（degraded=true，usage 全 null）。调用方据此切规则引擎兜底。 */
function degradedResult(): {
  degraded: boolean
  promptCacheHitTokens: number | null
  promptCacheMissTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
} {
  return {
    degraded: true,
    promptCacheHitTokens: null,
    promptCacheMissTokens: null,
    inputTokens: null,
    outputTokens: null,
  }
}

// =============================================================================
// proxy 路径选择
// =============================================================================

/**
 * 根据 provider 与 endpoint 选择 vite proxy 路径。
 *
 * 默认走 `/deepseek`（agent-browser 主验证路径）。
 * - deepseek → /deepseek/chat/completions
 * - openai/custom → 若 endpoint 含 deepseek 则走 /deepseek，否则降级 mock
 *   （浏览器直连 OpenAI 有 CORS，需各自配 proxy；当前仅配 deepseek）。
 *
 * @returns proxy 路径（相对路径，经 vite dev server 转发）
 */
function pickProxyPath(provider: string, endpoint: string): string {
  // 主路径：deepseek（vite proxy 已配）
  if (provider === 'deepseek') {
    return '/deepseek/chat/completions'
  }
  // custom/openai：若 endpoint 指向 deepseek，仍走 deepseek proxy
  if (endpoint.includes('deepseek.com')) {
    return '/deepseek/chat/completions'
  }
  // 其余（openai.com / anthropic）：当前未配 proxy，返回 deepseek 路径
  // 触发 fetch 失败 → 降级 mock（上层规则引擎兜底）
  // TODO：若需在浏览器验证 OpenAI/Anthropic，在 vite.config.ts 增对应 proxy。
  return '/deepseek/chat/completions'
}

// =============================================================================
// 类型：DeepSeek 流式 chunk（部分字段，仅取需要的）
// =============================================================================

/** DeepSeek/OpenAI 兼容的流式 chunk 形态（部分字段）。 */
interface DeepSeekStreamChunk {
  choices?: Array<{
    delta?: { content?: string; role?: string }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

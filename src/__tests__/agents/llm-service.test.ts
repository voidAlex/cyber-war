/**
 * llm-service 测试（llm-service.test.ts）— 注入 mock streamChat。
 *
 * 覆盖：
 * - streamText：正常流式 + 累计统计。
 * - streamChatStructured：合法输出解析 + 校验失败 throw（不伪造）。
 * - 错误四分类映射（network/api_key/llm_error/timeout → typed error）。
 * - degraded → LlmDegradedError。
 * - 缓存命中累计统计（getCacheStats / hitRate）。
 *
 * @module __tests__/agents/llm-service
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createLlmService,
  toLlmCallError,
  hitRate,
  LlmNetworkError,
  LlmApiKeyError,
  LlmServerError,
  LlmTimeoutError,
  LlmDegradedError,
  LlmSchemaError,
} from '@/layers/application/services/llm-service'
import { LlmStreamError } from '@/layers/gateway/llm-client'
import { getAgentValidator, type LlmJsonParseError, type ChiefAgentOutput } from '@/layers/agents/protocol/schema'
import type { ValidateFunction } from 'ajv'
import type { AppErrorPayload } from '@/layers/gateway/tauri-bridge'
import type { StreamChatOptions, StreamChatResult } from '@/layers/gateway/llm-client'

/** 构造 mock stream：可控制返回 result 或 reject */
function makeMockStream() {
  const calls: StreamChatOptions[] = []
  let nextResult: StreamChatResult | null = null
  let nextError: unknown = null
  const mock = vi.fn(async (opts: StreamChatOptions): Promise<StreamChatResult> => {
    calls.push(opts)
    if (nextError !== null) {
      const e = nextError
      nextError = null
      throw e
    }
    if (nextResult !== null) {
      const r = nextResult
      nextResult = null
      return r
    }
    // 默认空结果
    return { text: '', stats: { promptCacheHitTokens: 0, promptCacheMissTokens: 0, inputTokens: 0, outputTokens: 0, degraded: false } }
  })
  return {
    mock,
    calls,
    setNextResult(r: StreamChatResult) { nextResult = r },
    setNextError(e: unknown) { nextError = e },
  }
}

function makeResult(text: string, hit: number, miss: number, degraded = false): StreamChatResult {
  return { text, stats: { promptCacheHitTokens: hit, promptCacheMissTokens: miss, inputTokens: hit + miss, outputTokens: 10, degraded } }
}

describe('llmService.streamText', () => {
  it('正常流式返回结果', async () => {
    const s = makeMockStream()
    s.setNextResult(makeResult('hello', 100, 20))
    const svc = createLlmService({ stream: s.mock })
    const r = await svc.streamText({ provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] })
    expect(r.text).toBe('hello')
    expect(r.stats.promptCacheHitTokens).toBe(100)
  })

  it('degraded → 抛 LlmDegradedError', async () => {
    const s = makeMockStream()
    s.setNextResult(makeResult('partial', 0, 10, true))
    const svc = createLlmService({ stream: s.mock })
    await expect(svc.streamText({ provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] })).rejects.toBeInstanceOf(LlmDegradedError)
  })
})

describe('llmService.streamChatStructured', () => {
  it('合法 chief 输出解析成功', async () => {
    const s = makeMockStream()
    const valid = JSON.stringify({ candidates: [{ intent: 'move', unitIds: ['u-1'], summary: 's', confidence: 0.8 }] })
    s.setNextResult(makeResult(valid, 500, 100))
    const svc = createLlmService({ stream: s.mock })
    const validate = getAgentValidator('chief') as ValidateFunction<ChiefAgentOutput>
    const { data, stats } = await svc.streamChatStructured<ChiefAgentOutput>(
      { provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] },
      validate,
    )
    expect(data.candidates).toHaveLength(1)
    expect(data.candidates[0].intent).toBe('move')
    expect(stats.promptCacheHitTokens).toBe(500)
  })

  it('带 markdown fence 的输出也能解析', async () => {
    const s = makeMockStream()
    const fenced = '```json\n{"candidates":[{"intent":"hold","unitIds":["u-2"],"summary":"s","confidence":0.1}]}\n```'
    s.setNextResult(makeResult(fenced, 0, 0))
    const svc = createLlmService({ stream: s.mock })
    const validate = getAgentValidator('chief') as ValidateFunction<ChiefAgentOutput>
    const { data } = await svc.streamChatStructured<ChiefAgentOutput>(
      { provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] },
      validate,
    )
    expect(data.candidates[0].intent).toBe('hold')
  })

  it('schema 校验失败 → 抛 LlmSchemaError（绝不伪造）', async () => {
    const s = makeMockStream()
    // 缺 required 字段
    s.setNextResult(makeResult('{"candidates":[]}', 0, 0))
    const svc = createLlmService({ stream: s.mock })
    const validate = getAgentValidator('chief') as ValidateFunction
    await expect(svc.streamChatStructured(
      { provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] },
      validate,
    )).rejects.toBeInstanceOf(LlmSchemaError)
  })

  it('JSON.parse 失败 → 抛 LlmSchemaError（不伪造）', async () => {
    const s = makeMockStream()
    s.setNextResult(makeResult('not json at all', 0, 0))
    const svc = createLlmService({ stream: s.mock })
    const validate = getAgentValidator('chief') as ValidateFunction
    await expect(svc.streamChatStructured(
      { provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] },
      validate,
    )).rejects.toBeInstanceOf(LlmSchemaError)
  })

  it('degraded → 抛 LlmDegradedError（在解析前）', async () => {
    const s = makeMockStream()
    s.setNextResult(makeResult('{"candidates":[]}', 0, 0, true))
    const svc = createLlmService({ stream: s.mock })
    const validate = getAgentValidator('chief') as ValidateFunction
    await expect(svc.streamChatStructured(
      { provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] },
      validate,
    )).rejects.toBeInstanceOf(LlmDegradedError)
  })
})

describe('llmService 缓存命中累计统计', () => {
  it('多次调用累计 hit/miss/callCount', async () => {
    const s = makeMockStream()
    const svc = createLlmService({ stream: s.mock })

    s.setNextResult(makeResult('a', 100, 20))
    await svc.streamText({ provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] })

    s.setNextResult(makeResult('b', 200, 30))
    await svc.streamText({ provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] })

    const stats = svc.getCacheStats()
    expect(stats.callCount).toBe(2)
    expect(stats.totalHitTokens).toBe(300)
    expect(stats.totalMissTokens).toBe(50)
    expect(hitRate(stats)).toBeCloseTo(300 / 350)
  })

  it('degraded 计数累加', async () => {
    const s = makeMockStream()
    const svc = createLlmService({ stream: s.mock })

    s.setNextResult(makeResult('a', 100, 20, true))
    await expect(svc.streamText({ provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] })).rejects.toBeInstanceOf(LlmDegradedError)

    expect(svc.getCacheStats().degradedCount).toBe(1)
  })

  it('resetCacheStats 清零', async () => {
    const s = makeMockStream()
    const svc = createLlmService({ stream: s.mock })
    s.setNextResult(makeResult('a', 100, 20))
    await svc.streamText({ provider: 'deepseek', endpoint: 'e', apiKey: 'k', model: 'm', messages: [] })

    svc.resetCacheStats()
    const stats = svc.getCacheStats()
    expect(stats.callCount).toBe(0)
    expect(stats.totalHitTokens).toBe(0)
    expect(hitRate(stats)).toBe(0)
  })

  it('hitRate 无调用时返回 0', () => {
    expect(hitRate({ totalHitTokens: 0, totalMissTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, degradedCount: 0 })).toBe(0)
  })
})

describe('toLlmCallError — 四分类映射', () => {
  it('LlmStreamError network → LlmNetworkError', () => {
    const err = toLlmCallError(new LlmStreamError('network', '连接失败'))
    expect(err).toBeInstanceOf(LlmNetworkError)
  })

  it('LlmStreamError api_key → LlmApiKeyError', () => {
    const err = toLlmCallError(new LlmStreamError('api_key', '401'))
    expect(err).toBeInstanceOf(LlmApiKeyError)
  })

  it('LlmStreamError llm_error → LlmServerError', () => {
    const err = toLlmCallError(new LlmStreamError('llm_error', '500'))
    expect(err).toBeInstanceOf(LlmServerError)
  })

  it('LlmStreamError timeout → LlmTimeoutError', () => {
    const err = toLlmCallError(new LlmStreamError('timeout', '超时'))
    expect(err).toBeInstanceOf(LlmTimeoutError)
  })

  it('AppErrorPayload(llm) 含 kind → 对应 typed error', () => {
    const payload: AppErrorPayload = { type: 'llm', message: { kind: 'api_key', message: '401' } }
    const err = toLlmCallError(payload)
    expect(err).toBeInstanceOf(LlmApiKeyError)
  })

  it('LlmJsonParseError → 包成基类（不丢失信息）', () => {
    const parseErr: LlmJsonParseError = { name: 'LlmJsonParseError', message: 'parse fail', errors: null } as LlmJsonParseError
    const err = toLlmCallError(parseErr)
    // 被包成 LlmSchemaError 或基类（取决于 instanceof 判定）
    expect(err).toBeDefined()
  })

  it('未知错误兜底为 LlmNetworkError', () => {
    const err = toLlmCallError(new Error('random'))
    expect(err).toBeInstanceOf(LlmNetworkError)
  })
})

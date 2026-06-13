/**
 * 错误四分类映射测试（error-banner.test.ts）— 纯逻辑。
 *
 * 验证（对应重写计划「错误四分类提示」+ 审计教训「绝不把 ApiKey 失效误报为网络中断」）：
 * - LlmApiKeyError → kind:'api_key'（绝不归为 network）。
 * - LlmTimeoutError → kind:'timeout'。
 * - LlmNetworkError → kind:'network'。
 * - LlmDegradedError → kind:'degraded'。
 * - LlmSchemaError → kind:'schema'。
 * - LlmServerError / 未知 → kind:'server'。
 *
 * @module __tests__/error-banner
 */

import { describe, it, expect } from 'vitest'
import {
  LlmApiKeyError,
  LlmTimeoutError,
  LlmNetworkError,
  LlmDegradedError,
  LlmSchemaError,
  LlmServerError,
  errorToBanner,
} from '@/layers/application/services/llm-service'

describe('errorToBanner — 四分类映射', () => {
  it('LlmApiKeyError → api_key（绝不误报为网络中断）', () => {
    const banner = errorToBanner(new LlmApiKeyError('401'))
    expect(banner.kind).toBe('api_key')
    expect(banner.message).toContain('API Key')
  })

  it('LlmTimeoutError → timeout', () => {
    const banner = errorToBanner(new LlmTimeoutError('timeout'))
    expect(banner.kind).toBe('timeout')
    expect(banner.message).toContain('超时')
  })

  it('LlmNetworkError → network', () => {
    const banner = errorToBanner(new LlmNetworkError('dns fail'))
    expect(banner.kind).toBe('network')
    expect(banner.message).toContain('网络')
  })

  it('LlmDegradedError → degraded', () => {
    const banner = errorToBanner(new LlmDegradedError('degraded'))
    expect(banner.kind).toBe('degraded')
    expect(banner.message).toContain('降级')
  })

  it('LlmSchemaError → schema', () => {
    const banner = errorToBanner(new LlmSchemaError('bad', 'raw'))
    expect(banner.kind).toBe('schema')
    expect(banner.message).toContain('格式')
  })

  it('LlmServerError → server', () => {
    const banner = errorToBanner(new LlmServerError('500'))
    expect(banner.kind).toBe('server')
  })

  it('未知错误 → server', () => {
    const banner = errorToBanner(new Error('boom'))
    expect(banner.kind).toBe('server')
    expect(banner.message).toBe('boom')
  })

  it('ApiKey 与 Network 严格区分（审计红线）', () => {
    const api = errorToBanner(new LlmApiKeyError('403'))
    const net = errorToBanner(new LlmNetworkError('econnrefused'))
    expect(api.kind).not.toBe('network')
    expect(net.kind).not.toBe('api_key')
  })
})

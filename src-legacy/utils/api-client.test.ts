import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLLM } from './api-client'
import { AppError } from './error-handling'

describe('fetchLLM 网络异常处理', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('网络异常时应触发 onNetworkError 并抛出 AppError.network', async () => {
    const onNetworkError = vi.fn()

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    )

    await expect(
      fetchLLM({
        provider: 'openai',
        endpoint: 'https://api.example.com/v1/chat/completions',
        payload: { messages: [] },
        apiKey: 'test-key',
        onNetworkError,
      })
    ).rejects.toMatchObject({
      name: 'AppError',
      type: 'network',
    } satisfies Partial<AppError>)

    expect(onNetworkError).toHaveBeenCalledTimes(1)
  })
})

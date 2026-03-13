/**
 * LLM API 客户端封装
 * 
 * 负责与后端代理转发接口通信，并处理网络异常（触发游戏暂停）。
 * 
 * @module utils/api-client
 */

import { AppError } from './error-handling'
import { getLogger } from './logger'

const logger = getLogger({ context: 'ApiClient' })

interface FetchLLMOptions {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  payload: Record<string, unknown>
  apiKey: string
  // 提供给状态机进行异常保护的方法
  onNetworkError?: () => void
}

/**
 * 请求后端 LLM 转发代理
 */
export async function fetchLLM(options: FetchLLMOptions): Promise<Response> {
  const { provider, endpoint, payload, apiKey, onNetworkError } = options
  
  try {
    const res = await fetch('/api/llm/forward', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider,
        endpoint,
        payload,
        apiKey
      })
    })

    if (!res.ok) {
      const message = await res.text()
      throw new Error(`HTTP Error: ${res.status} ${res.statusText}${message ? ` - ${message}` : ''}`)
    }

    return res

  } catch (error) {
    logger.error('API 请求失败', { error, endpoint })
    
    // 如果是网络连接异常导致的失败
    if (error instanceof TypeError && error.message.includes('fetch')) {
      if (onNetworkError) {
        onNetworkError()
      }
      throw AppError.network('网络连接中断，游戏已自动暂停', error)
    }

    if (onNetworkError) {
      onNetworkError()
    }
    throw AppError.network('后端服务无法连接或响应异常', error instanceof Error ? error : new Error(String(error)))
  }
}

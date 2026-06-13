/**
 * LLM 客户端 Hook
 *
 * 封装 fetchLLM 调用，自动绑定 onNetworkError → pauseGame 链路。
 * 当网络异常发生时，状态机自动进入暂停状态，保护游戏数据一致性。
 *
 * @module game/use-llm-client
 */

import { useCallback } from 'react'
import { fetchLLM } from '@utils/api-client'
import type { StateMachineAction } from './state-machine'

/**
 * LLM 请求参数（不含 onNetworkError，由 hook 自动注入）
 */
interface LLMRequestOptions {
  /** LLM 供应商 */
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  /** 请求端点 */
  endpoint: string
  /** 请求负载 */
  payload: Record<string, unknown>
  /** API 密钥 */
  apiKey: string
}

/**
 * useLLMClient 返回类型
 */
export interface UseLLMClientReturn {
  /** 发送 LLM 请求（网络异常时自动暂停游戏） */
  sendRequest: (options: LLMRequestOptions) => Promise<Response>
}

/**
 * LLM 客户端 Hook
 *
 * 将 fetchLLM 与游戏状态机绑定：
 * - 网络异常时自动 dispatch PAUSE_GAME，保障状态一致性
 * - 业务层无需关心错误暂停逻辑，只需调用 sendRequest
 *
 * @param dispatch - 状态机 dispatch 函数
 * @returns LLM 客户端操作方法
 *
 * @example
 * ```tsx
 * const { context, dispatch } = useGameState()
 * const { sendRequest } = useLLMClient(dispatch)
 *
 * // 在结算阶段调用 LLM
 * const response = await sendRequest({
 *   provider: 'openai',
 *   endpoint: '/v1/chat/completions',
 *   payload: { messages: [...] },
 *   apiKey: 'sk-...',
 * })
 * ```
 */
export function useLLMClient(
  dispatch: (action: StateMachineAction) => void
): UseLLMClientReturn {
  /**
   * 网络异常回调：触发状态机暂停
   */
  const handleNetworkError = useCallback(() => {
    dispatch({ type: 'PAUSE_GAME' })
  }, [dispatch])

  /**
   * 发送 LLM 请求
   *
   * 自动注入 onNetworkError 回调，网络异常时暂停游戏。
   *
   * @param options - LLM 请求参数
   * @returns 原始 Response 对象（支持流式读取）
   * @throws AppError 网络异常或服务端错误时抛出
   */
  const sendRequest = useCallback(
    async (options: LLMRequestOptions): Promise<Response> => {
      return fetchLLM({
        ...options,
        onNetworkError: handleNetworkError,
      })
    },
    [handleNetworkError]
  )

  return { sendRequest }
}
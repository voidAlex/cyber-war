/**
 * 错误处理工具
 * 
 * 提供统一的错误处理机制。
 * 
 * @module utils/error-handling
 */

/**
 * 应用错误类型
 */
export type AppErrorType = 
  | 'network'
  | 'storage'
  | 'validation'
  | 'permission'
  | 'not_found'
  | 'state_corrupt'
  | 'unknown'
  | 'timeout'
  | 'canceled'
  | 'quota_exceeded'
  | 'browser_unsupported'
  | 'api_error'
  | 'llm_error'
  | 'game_logic'

/**
 * 应用错误类
 */
export class AppError extends Error {
  readonly type: AppErrorType
  readonly code: string
  readonly recoverable: boolean
  readonly cause?: Error

  constructor(
    type: AppErrorType,
    message: string,
    code?: string,
    options?: {
      recoverable?: boolean
      cause?: Error
    }
  ) {
    super(message)
    this.name = 'AppError'
    this.type = type
    this.code = code ?? type.toUpperCase()
    this.recoverable = options?.recoverable ?? false
    this.cause = options?.cause
  }

  /**
   * 转换为用户友好的错误消息
   */
  toUserMessage(): string {
    const messages: Record<AppErrorType, string> = {
      network: '网络连接失败，请检查您的网络连接',
      storage: '存储操作失败，数据可能未保存',
      validation: '数据验证失败，请检查输入',
      permission: '权限不足，无法执行此操作',
      not_found: '请求的资源不存在',
      state_corrupt: '游戏状态已损坏，请尝试从快照恢复',
      unknown: '发生未知错误，请稍后重试',
      timeout: '操作超时，请稍后重试',
      canceled: '操作已取消',
      quota_exceeded: '存储空间不足，请清理旧存档',
      browser_unsupported: '您的浏览器不支持此功能',
      api_error: 'API 请求失败，请检查您的配置',
      llm_error: 'AI 服务响应异常，请稍后重试',
      game_logic: '游戏逻辑错误，请检查游戏规则',
    }
    
    return messages[this.type] ?? this.message
  }

  /**
   * 创建网络错误
   */
  static network(message: string, cause?: Error): AppError {
    return new AppError('network', message, 'NETWORK_ERROR', {
      recoverable: true,
      cause,
    })
  }

  /**
   * 创建存储错误
   */
  static storage(message: string, cause?: Error): AppError {
    return new AppError('storage', message, 'STORAGE_ERROR', {
      recoverable: false,
      cause,
    })
  }
}

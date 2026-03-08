/**
 * 日志工具
 * 
 * 提供统一的日志记录机制。
 * 
 * @module utils/logger
 */

/**
 * 日志级别
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/**
 * 日志记录器类
 */
export class Logger {
  public minLevel: LogLevel
  public context?: string

  constructor(config?: { minLevel?: LogLevel; context?: string }) {
    this.minLevel = config?.minLevel ?? 'info'
    this.context = config?.context
  }

  /**
   * 记录日志
   */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const levels: LogLevel[] = ['error', 'warn', 'info', 'debug']
    if (levels.indexOf(level) < levels.indexOf(this.minLevel)) {
      return
    }

    const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`
    const fullMessage = this.context 
      ? `${prefix} [${this.context}] ${message}`
      : `${prefix} ${message}`

    switch (level) {
      case 'error':
        console.error(fullMessage, data ?? '')
        break
      case 'warn':
        console.warn(fullMessage, data ?? '')
        break
      case 'info':
        console.info(fullMessage, data ?? '')
        break
      case 'debug':
        console.debug(fullMessage, data ?? '')
        break
    }
  }

  /**
   * 记录错误
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data)
  }

  /**
   * 记录警告
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data)
  }

  /**
   * 记录信息
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data)
  }

  /**
   * 记录调试
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data)
  }
}

/**
 * 全局日志记录器实例
 */
let globalLogger: Logger | null = null

/**
 * 获取全局日志记录器
 */
export function getLogger(config?: { minLevel?: LogLevel; context?: string }): Logger {
  if (!globalLogger) {
    globalLogger = new Logger(config)
  } else if (config) {
    globalLogger = new Logger({
      minLevel: config.minLevel ?? globalLogger.minLevel,
      context: config.context ?? globalLogger.context,
    })
  }
  return globalLogger
}

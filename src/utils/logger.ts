/**
 * 统一日志模块（logger.ts）— 全应用可观测层。
 *
 * 设计目标（重写计划「详细日志 + 桌面端 log 文件便于排查」）：
 * - **统一入口**：`logger.log(level, category, message, context?)` + 便捷方法
 *   `logger.debug/info/warn/error(category, message, context?)`，全应用一致。
 * - **双写**：console（dev 全级、prod info+）+ best-effort 经 gateway 落盘
 *   （不阻塞主流程、不 reject、失败静默 console.warn）。
 * - **双轨**：
 *   - `scope:'app'`（默认）→ 全局应用日志 `<app_data_dir>/logs/app.log`
 *     （启动/配置/致命错误/未捕获异常等跨存档事件）。
 *   - `scope:'save'` + `saveId` → 存档内 `saves/<saveId>/diagnostics.log`
 *     （state/Agent/物理/LLM/用户操作等存档内事件）。
 * - **脱敏**：context 与 message 经 [`sanitize`] 深度脱敏，剔除 apiKey/payload/
 *   Bearer/token/password/secret 等敏感字段，绝不落明文 key。
 * - **结构化**：每条落盘为一行 JSON `{ts, level, category, message, context, turn?}`，
 *   便于 grep / 按类别排查。
 * - **确定性**：纯可观测副作用，不影响游戏逻辑/回放（不参与 event-log/重算）。
 *   测试中通过注入 sink 回退 console（不真写文件，避免污染）。
 *
 * 铁律：
 * - **best-effort**：写盘失败只 console.warn，绝不抛错、绝不阻塞游戏循环。
 * - **安全**：复用并强化 diagnostics 的 sanitize 思路；app.log/diagnostics.log
 *   绝不含明文 apiKey。
 * - gateway 唯一 import `@tauri-apps/api`；本模块经 gateway 落盘，不直接 import tauri。
 *
 * @module utils/logger
 */

import { fsAppendAppLog, fsAppendDiagnostics } from '@/layers/gateway/tauri-bridge'

// =============================================================================
// 类型契约
// =============================================================================

/** 日志级别（与 console 方法对齐）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 日志 scope：决定落 app.log 还是存档 diagnostics.log。
 *
 * - `'app'`：跨存档全局事件（启动、配置、致命错误、未捕获异常）。写 app.log。
 * - `'save'`：存档内事件（state/Agent/物理/LLM/用户操作）。写 diagnostics.log，
 *   必须提供 saveId；saveId 缺失时降级写 app.log（best-effort，绝不丢日志）。
 */
export type LogScope = 'app' | 'save'

/**
 * 日志上下文（脱敏前）。每条日志的结构化附加信息。
 *
 * 内部字段（控制落盘行为，本身不写盘）：
 * - `scope`：决定写 app.log（'app'）还是 diagnostics.log（'save'）。
 * - `saveId`：scope='save' 时目标存档 id。
 * - `turn`：当前回合号（确定性友好，便于回放/排查特定回合）。
 *
 * 其余键作为业务上下文，经 [`sanitizeContext`] 深度脱敏后写入 context 字段。
 */
export interface LogContext {
  /** 落盘目标：app.log 或 存档 diagnostics.log */
  scope?: LogScope
  /** scope='save' 时的目标存档 id（缺失则降级写 app.log） */
  saveId?: string
  /** 当前回合号（可选，便于排查特定回合） */
  turn?: number
  /** 业务上下文键值（脱敏后写盘） */
  [key: string]: unknown
}

/**
 * 落盘 sink（依赖注入，测试可 mock）。默认指向 gateway 实现。
 *
 * 注入 fake sink 后，logger 不再走 gateway（适合纯函数测试，不触达 Tauri/fetch）。
 */
export interface LogSink {
  /** 写全局应用日志（一行 JSON） */
  appendAppLog(line: string): Promise<void>
  /** 写存档诊断日志（一行 JSON） */
  appendDiagnostics(saveId: string, line: string): Promise<void>
}

// =============================================================================
// 配置：环境级别过滤
// =============================================================================

/**
 * 是否为生产环境（prod 仅 info+，dev 全级别）。
 *
 * 判定：`import.meta.env.PROD`（Vite 注入）。测试环境（vitest）也算非 prod，
 * 故 dev/test 都全级别输出 console。
 */
function isProd(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    // import.meta.env 不可用时保守视为非 prod（dev/test 全级别）
    return false
  }
}

/** 级别是否应输出到 console（prod 屏蔽 debug）。 */
function shouldConsole(level: LogLevel): boolean {
  if (isProd()) {
    return level !== 'debug'
  }
  return true
}

// =============================================================================
// 脱敏：context 深度脱敏 + message 兜底脱敏（绝不落明文 key）
// =============================================================================

/**
 * 敏感键名集合（小写匹配）。context 中匹配这些键的值会被替换为 `'***'`，
 * 绝不落明文。覆盖常见密钥/令牌/凭证字段名。
 */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'password',
  'payload',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refresh_token',
  'bearertoken',
  'bearer',
  'privatekey',
  'private_key',
  'sessionkey',
  'session_key',
])

/** message 最大长度（截断超长概要，避免日志膨胀/泄漏大量上下文）。 */
const MAX_MESSAGE_LEN = 280

/** context 单字符串值最大长度（截断超长值，防日志膨胀）。 */
const MAX_VALUE_LEN = 200

/**
 * 脱敏单个 message：移除常见敏感关键字模式，并截断超长内容。
 *
 * 即便调用方误把 key/payload 拼进 message，这里也只落脱敏后的概要。
 * 与 diagnostics.ts 的 sanitize 同思路（这里复用并强化，确保 app.log 同样安全）。
 */
function sanitizeMessage(raw: string): string {
  let s = raw
  // 1. API key 片段（OpenAI/DeepSeek 风格 sk-、sk_）优先脱敏
  s = s.replace(/sk[-_][A-Za-z0-9-_]{4,}/gi, 'sk-***')
  // 2. Bearer 令牌（含 JWT：字符集含 . 字符；贪婪到空白/结尾）
  s = s.replace(/Bearer\s+[^\s]+/gi, 'Bearer ***')
  // 3. 敏感键赋值：贪婪吃掉「=」/「:」之后到行尾或下一个顶层分隔符的内容
  s = s.replace(
    /(api[_-]?key|authorization|password|payload|secret|token)\s*[:=]\s*[^;\n\r]+/gi,
    '$1=***',
  )
  // 4. 截断超长（兜底：即便上述脱敏后仍过长）
  if (s.length > MAX_MESSAGE_LEN) {
    s = s.slice(0, MAX_MESSAGE_LEN) + '…'
  }
  return s
}

/**
 * 深度脱敏 context 对象：递归遍历，把敏感键的值替换为 `'***'`，
 * 截断超长字符串值，跳过函数/Symbol。
 *
 * 安全保证：返回的对象绝不会包含 SENSITIVE_KEYS 中键的明文值。
 *
 * @param ctx 原始 context（可能含敏感字段）
 * @param depth 递归深度（防循环引用/过深嵌套，上限 5）
 */
function sanitizeContext(ctx: unknown, depth = 0): unknown {
  // 基本类型：字符串截断，其余原样
  if (typeof ctx === 'string') {
    return ctx.length > MAX_VALUE_LEN ? ctx.slice(0, MAX_VALUE_LEN) + '…' : ctx
  }
  if (ctx === null || typeof ctx !== 'object') {
    return ctx
  }
  // 深度上限：超出返回占位（防恶意/循环结构）
  if (depth > 5) return '<…深>'

  // 数组：逐项递归
  if (Array.isArray(ctx)) {
    return ctx.map((item) => sanitizeContext(item, depth + 1))
  }

  // 对象：逐键脱敏
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(ctx)) {
    if (typeof key === 'symbol') continue
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '***'
    } else if (typeof value === 'function') {
      // 函数不落盘（可能闭包持有敏感数据）
      out[key] = '<fn>'
    } else {
      out[key] = sanitizeContext(value, depth + 1)
    }
  }
  return out
}

// =============================================================================
// 落盘 sink：默认走 gateway，测试可注入 fake
// =============================================================================

/**
 * 当前环境是否可落盘（避免 vitest/Node 环境触达 gateway 抛 window undefined）。
 *
 * vitest 在 Node/jsdom 下跑，gateway 的 invoke 需 `window.__TAURI_INTERNALS__`，
 * web-mock 需真浏览器；两者在测试环境都不可用。测试环境应注入 fake sink
 * （setLogSink）或回退纯 console，绝不真落盘（避免污染 + 噪音堆栈）。
 *
 * 判定：Vite 注入 `import.meta.env.MODE`，vitest 默认为 'test'/'development'；
 * 兜底再检查 `window` 是否存在。生产（Tauri/web dev）MODE 非 test 且 window 存在。
 */
function canPersist(): boolean {
  try {
    const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE
    if (mode === 'test') return false
  } catch {
    // import.meta.env 不可用（如纯 Node），保守视为不可落盘
    return false
  }
  // 非 test 环境进一步检查 window 存在（Node 主线程无 window）
  return typeof window !== 'undefined'
}

/**
 * 默认 sink：经 gateway 落盘（gateway 是唯一 import @tauri-apps/api 的层）。
 *
 * 注意：fsAppendAppLog/fsAppendDiagnostics 内部已处理 web-mode 降级与 Tauri invoke，
 * 这里只做调用，不重试（best-effort）。测试环境（vitest）canPersist() 返回 false，
 * 自动 no-op，避免触达 gateway 抛 window undefined（测试应注入 fake sink 或回退 console）。
 */
const defaultSink: LogSink = {
  appendAppLog(line) {
    if (!canPersist()) return Promise.resolve()
    return fsAppendAppLog(line)
  },
  appendDiagnostics(saveId, line) {
    if (!canPersist()) return Promise.resolve()
    return fsAppendDiagnostics(saveId, line)
  },
}

/**
 * 当前生效 sink（模块级单例，可经 [`setLogSink`] 替换）。
 *
 * 默认指向 gateway；测试用 setLogSink 注入 fake 后回退 console。
 */
let activeSink: LogSink = defaultSink

/**
 * 替换当前 sink（测试用）。
 *
 * 注入 fake sink 后，logger 不再触达 Tauri/fetch；测试可捕获落盘行断言。
 * 传 null 恢复默认 gateway sink。
 *
 * @param sink 新 sink 或 null（恢复默认）
 */
export function setLogSink(sink: LogSink | null): void {
  activeSink = sink ?? defaultSink
}

// =============================================================================
// 核心：log()
// =============================================================================

/**
 * 统一日志入口。
 *
 * 行为：
 * 1. console 输出（dev 全级，prod info+），按 level 选 console 方法。
 * 2. best-effort 落盘：根据 `context.scope` 决定写 app.log 还是 diagnostics.log。
 *    - scope='save' 且有 saveId → diagnostics.log（该存档）。
 *    - 其他（含 scope='app' / saveId 缺失）→ app.log。
 *    落盘为单行 JSON：`{ts, level, category, message, context, turn?}`，
 *    context/message 均经脱敏。
 * 3. **best-effort**：落盘失败只 console.warn，绝不抛错、绝不阻塞调用方。
 *
 * @param level 日志级别
 * @param category 类别（点分，如 `app/startup`、`llm/network`、`persist`、`ui/command`）
 * @param message 概要描述（脱敏后落盘）
 * @param context 上下文（含 scope/saveId/turn + 业务字段，脱敏后落盘）
 */
export function log(
  level: LogLevel,
  category: string,
  message: string,
  context?: LogContext,
): void {
  // 1. console 输出（按级别选方法）
  if (shouldConsole(level)) {
    const consoleMethod =
      level === 'debug'
        ? console.debug
        : level === 'info'
          ? console.info
          : level === 'warn'
            ? console.warn
            : console.error
    // console 用带 category 前缀的可读格式 + 原始 context（dev 调试用，未脱敏）
    consoleMethod.call(console, `[${category}] ${message}`, context ?? {})
  }

  // 2. best-effort 落盘（绝不抛错）
  //    提前序列化 + 脱敏，避免 sink 内部异步过程中持有原始 context。
  const safeMessage = sanitizeMessage(message)
  // 剥离控制字段（scope/saveId/turn），剩余作为业务上下文脱敏写盘
  const { scope, saveId, turn, ...business } = context ?? {}
  const safeContext = sanitizeContext(business)

  const line = JSON.stringify({
    ts: Date.now(),
    level,
    category,
    message: safeMessage,
    ...(Object.keys(safeContext as Record<string, unknown>).length > 0
      ? { context: safeContext }
      : {}),
    ...(typeof turn === 'number' ? { turn } : {}),
  })

  // 决定落盘目标：save+saveId → diagnostics；否则 app.log
  const target = scope === 'save' && typeof saveId === 'string' && saveId.length > 0
    ? { kind: 'save' as const, saveId: saveId! }
    : { kind: 'app' as const }

  // fire-and-forget（不 await）：logger 绝不阻塞调用方/游戏循环
  void writeBestEffort(target, line)
}

/**
 * best-effort 落盘：失败只 console.warn，绝不 reject。
 *
 * 抽成独立异步函数便于统一兜底。
 */
async function writeBestEffort(
  target: { kind: 'app' } | { kind: 'save'; saveId: string },
  line: string,
): Promise<void> {
  try {
    if (target.kind === 'app') {
      await activeSink.appendAppLog(line)
    } else {
      await activeSink.appendDiagnostics(target.saveId, line)
    }
  } catch (err) {
    // 落盘失败：只 console.warn，绝不抛错（best-effort 日志）
    // 用 console.warn 而非 logger 递归（防无限递归）
    console.warn('[logger] 落盘失败，已忽略', err)
  }
}

// =============================================================================
// 便捷方法：logger.debug/info/warn/error(category, message, context?)
// =============================================================================

/**
 * 日志便捷对象（默认导出形态）。
 *
 * 用法：
 * ```ts
 * import { logger } from '@/utils/logger'
 * logger.info('app/startup', '应用启动', { scope: 'app' })
 * logger.error('llm/network', 'LLM 调用失败', { scope: 'save', saveId, turn, kind })
 * ```
 */
export const logger = {
  /** debug 级别（dev 全输出，prod 屏蔽）。 */
  debug(category: string, message: string, context?: LogContext): void {
    log('debug', category, message, context)
  },
  /** info 级别。 */
  info(category: string, message: string, context?: LogContext): void {
    log('info', category, message, context)
  },
  /** warn 级别。 */
  warn(category: string, message: string, context?: LogContext): void {
    log('warn', category, message, context)
  },
  /** error 级别。 */
  error(category: string, message: string, context?: LogContext): void {
    log('error', category, message, context)
  },
  /** 显式 log 入口（指定 level）。 */
  log,
}

// =============================================================================
// 便于单测：导出脱敏纯函数
// =============================================================================

/** message 脱敏纯函数（导出便于单测，不依赖 gateway）。 */
export const __sanitizeMessageForTest = sanitizeMessage

/** context 脱敏纯函数（导出便于单测，不依赖 gateway）。 */
export const __sanitizeContextForTest = sanitizeContext

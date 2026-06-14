/**
 * 诊断日志（diagnostics.ts）— 追加 status code / 错误类别到 diagnostics.log（Rust 真追加）。
 *
 * 铁律（AGENTS.md / error.rs）：diagnostics 只写 status code / 类别描述，
 * **绝不写 apiKey / payload 明文**。本模块在落盘前对 message 做脱敏裁剪，
 * 即便调用方误传敏感信息也只落概要。
 *
 * 落盘经 gateway `fs_append_diagnostics`（一行 JSON），Rust 侧 O_APPEND 真追加（O(1)）。
 * gateway 是唯一 import `@tauri-apps/api` 的层；本模块不直接 import tauri。
 *
 * 接入点：
 * - llm-service 错误分类路径：捕获 LlmCallError 时落 error 级诊断（category=llm/<kind>）。
 * - turn-orchestrator persist 失败路径：PERSIST_FAILED 时落 error 级诊断（category=persist）。
 *
 * @module layers/persistence/diagnostics
 */

import { fsAppendDiagnostics } from '@/layers/gateway/tauri-bridge'

// =============================================================================
// 类型契约
// =============================================================================

/** 诊断级别（与常见日志级别对齐）。 */
export type DiagnosticLevel = 'error' | 'warn' | 'info'

/**
 * 单条诊断条目。落盘为一行 JSON。
 *
 * 安全约束：本接口字段**仅允许** status code / 类别 / 概要描述。
 * 严禁塞入 apiKey、payload、请求体、响应体等敏感明文。
 * 落盘前 [`sanitize`] 会做兜底脱敏（双保险）。
 */
export interface DiagnosticEntry {
  /** 级别 */
  level: DiagnosticLevel
  /**
   * 类别（点分）：如 `llm/network`、`llm/api_key`、`persist`。
   * 便于 diagnostics.log 按类别 grep 排查。
   */
  category: string
  /** 概要描述（人类可读，脱敏后）。绝不包含 key/payload 明文。 */
  message: string
  /** HTTP status code 或自定义数字编码（可选）。 */
  code?: number
  /** 时间戳（Unix 毫秒）。由调用方传入或默认取 Date.now()。 */
  ts?: number
}

// =============================================================================
// 脱敏：兜底防御，确保绝不落 apiKey / payload 明文
// =============================================================================

/** message 最大长度（截断超长概要，避免日志膨胀/泄漏大量上下文）。 */
const MAX_MESSAGE_LEN = 280

/**
 * 脱敏单个 message：移除常见敏感关键字模式，并截断超长内容。
 *
 * 即便调用方误把 key/payload 拼进 message，这里也只落脱敏后的概要。
 * 匹配的模式（大小写不敏感）：
 * - `sk-` / `sk_` 开头或含的 API key 片段 → `sk-***`
 * - `Bearer <token>` 令牌（含 JWT） → `Bearer ***`
 * - `authorization: ...` / `apiKey=...` / `api_key=...` / `password=...` /
 *   `payload=...` / `secret=...` / `token=...` 赋值 → 截断到行尾/下一个
 *   顶层分隔符的值（贪婪，能吃掉含 `{` `}` `:` `"` 的 JSON 片段，防 payload 泄漏）
 */
function sanitize(raw: string): string {
  let s = raw
  // 1. API key 片段（OpenAI/DeepSeek 风格 sk-、sk_）优先脱敏
  s = s.replace(/sk[-_][A-Za-z0-9-_]{4,}/gi, 'sk-***')
  // 2. Bearer 令牌（含 JWT：字符集含 . 字符；贪婪到空白/结尾）
  s = s.replace(/Bearer\s+[^\s]+/gi, 'Bearer ***')
  // 3. 敏感键赋值：贪婪吃掉「=」/「:」之后到行尾或下一个顶层分隔符的内容。
  //    分隔符集合排除了引号/花括号/冒号（payload 可能是 JSON），确保 JSON 体内的
  //    敏感值（如 {"secret":"top"}）被整段吃掉而非残留。
  //    捕获组保留键名，值替换为 ***。
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

// =============================================================================
// 对外 API
// =============================================================================

/**
 * 追加一条诊断到 diagnostics.log（经 gateway `fs_append_diagnostics`）。
 *
 * - message 经 [`sanitize`] 脱敏兜底，绝不落 apiKey/payload 明文。
 * - 序列化为一行 JSON 后交 Rust O_APPEND 真追加。
 * - **绝不 reject**：诊断是 best-effort 日志，落盘/网关失败一律静默吞掉，
 *   不得打断主流程（含调用方用 `void appendDiagnostic(...)` fire-and-forget 的场景）。
 *
 * @param saveId 存档 id（决定 diagnostics.log 路径）
 * @param entry 诊断条目（脱敏前/后均可，函数内部兜底脱敏）
 */
export async function appendDiagnostic(
  saveId: string,
  entry: DiagnosticEntry,
): Promise<void> {
  const line = JSON.stringify({
    level: entry.level,
    category: entry.category,
    // 兜底脱敏：调用方即便误传敏感信息也只落概要
    message: sanitize(entry.message),
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    ts: entry.ts ?? Date.now(),
  })
  try {
    // 经 gateway 落盘（gateway 是唯一 import @tauri-apps/api 的层）
    await fsAppendDiagnostics(saveId, line)
  } catch {
    // 诊断落盘失败绝不抛错打断主流程（best-effort 日志）
  }
}

// =============================================================================
// 便于单测：导出脱敏纯函数
// =============================================================================

/** 脱敏纯函数（导出便于单测，不依赖 gateway）。 */
export const __sanitizeForTest = sanitize

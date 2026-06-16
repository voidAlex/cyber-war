/**
 * 局内日期纯函数助手（in-game-date.ts）— 无副作用、无 Tauri、可单测。
 *
 * 用途（UI 重构第 1 批「全对话为主」）：
 * - Header 时间显示：从开局日期 startInGameDate + turnIndex × daysPerTurn 推算当前局内日期，
 *   并格式化为「YYYY-MM-DD（第{n}天 D+{n}）」。
 * - reducer NEXT_TURN：把局内日期推进 daysPerTurn 天（纯函数，reducer 直接调用）。
 *
 * 仅支持 ISO 8601 日期（YYYY-MM-DD）。非 ISO 日期（如旧存档的 'D-0'）原样返回——
 * 保证不破坏旧测试存档与无日期剧本（回退到 turnIndex 显示）。
 *
 * 确定性：基于 Date.UTC 整数运算，无随机/时区副作用，CI 回放哈希稳定。
 *
 * @module utils/in-game-date
 */

/** 默认每回合推进天数（manifest 未指定 daysPerTurn 时取此值）。 */
export const DEFAULT_DAYS_PER_TURN = 1

/** 局内日期格式：匹配 YYYY-MM-DD。 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 判断字符串是否为 ISO 日期（YYYY-MM-DD）。
 *
 * 非 ISO 日期（如 'D-0' / 'D+3'）返回 false，调用方据此回退到 turnIndex 显示。
 */
export function isIsoInGameDate(date: string): boolean {
  return ISO_DATE_RE.test(date)
}

/**
 * 把 ISO 日期字符串解析为 UTC 毫秒数（纯整数运算，无时区漂移）。
 *
 * 仅在 isIsoInGameDate 为真时调用；非 ISO 抛 RangeError。
 */
function parseIsoDate(date: string): number {
  // 'YYYY-MM-DD' → [Y, M, D]
  const [y, m, d] = date.split('-').map((s) => Number.parseInt(s, 10))
  // Date.UTC 月份 0 起步
  return Date.UTC(y, m - 1, d)
}

/**
 * 把 UTC 毫秒数格式化为 ISO 日期（YYYY-MM-DD）。
 */
function formatIsoDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 把局内日期推进指定天数（纯函数）。
 *
 * - ISO 日期：精确加 days 天返回新 ISO 日期。
 * - 非 ISO 日期（旧存档 'D-0' 等）：原样返回（不破坏旧数据）。
 *
 * @param date 当前局内日期
 * @param days 推进天数（默认 1）
 * @returns 推进后的局内日期
 */
export function advanceInGameDate(date: string, days = DEFAULT_DAYS_PER_TURN): string {
  if (!isIsoInGameDate(date)) return date
  return formatIsoDate(parseIsoDate(date) + days * 86_400_000)
}

/**
 * 从开局日期推算第 turnIndex 回合的当前局内日期（Header 显示用）。
 *
 * startInGameDate + turnIndex × daysPerTurn。turnIndex 从 0 起步（第 0 回合=开局日）。
 *
 * 非 ISO 开局日期返回 null（调用方回退到纯 turnIndex 显示）。
 *
 * @param startInGameDate 开局日期（manifest.startInGameDate）
 * @param turnIndex 当前回合号（0 起步）
 * @param daysPerTurn 每回合天数（默认 1）
 */
export function computeInGameDate(
  startInGameDate: string | undefined,
  turnIndex: number,
  daysPerTurn = DEFAULT_DAYS_PER_TURN,
): string | null {
  if (startInGameDate === undefined || !isIsoInGameDate(startInGameDate)) return null
  return formatIsoDate(parseIsoDate(startInGameDate) + turnIndex * daysPerTurn * 86_400_000)
}

/**
 * 格式化局内日期为 Header 显示串：`YYYY-MM-DD（第{n}天 D+{n}）`。
 *
 * - ISO 开局日期：推算并返回完整串（第{turnIndex+1}天 D+{turnIndex}）。
 * - 无 ISO 日期或推算失败：返回 null，调用方回退到 `TURN {turnIndex}`。
 *
 * @example
 * formatHeaderDate('1916-02-21', 3) → '1916-02-24（第4天 D+3）'
 *
 * @param startInGameDate 开局日期
 * @param turnIndex 当前回合号（0 起步）
 * @param daysPerTurn 每回合天数（默认 1）
 */
export function formatHeaderDate(
  startInGameDate: string | undefined,
  turnIndex: number,
  daysPerTurn = DEFAULT_DAYS_PER_TURN,
): string | null {
  const current = computeInGameDate(startInGameDate, turnIndex, daysPerTurn)
  if (current === null) return null
  const dayNum = turnIndex + 1
  return `${current}（第${dayNum}天 D+${turnIndex}）`
}

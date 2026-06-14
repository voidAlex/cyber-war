/**
 * 诊断日志测试（diagnostics.test.ts）— P2-2。
 *
 * 覆盖：
 * - appendDiagnostic 经 gateway fs_append_diagnostics 落盘（mock 捕获调用）。
 * - 序列化为一行 JSON，含 level/category/message/code/ts。
 * - 兜底脱敏：apiKey / payload / Bearer / password 不得落明文。
 * - 默认 ts 自动补 Date.now()。
 *
 * 通过 vi.mock 替换 @/layers/gateway/tauri-bridge，捕获 fs_append_diagnostics 调用，
 * 不真落盘（符合「gateway 是唯一 import @tauri-apps/api 的层」；本测试不触达 Rust）。
 *
 * @module __tests__/diagnostics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// mock @/layers/gateway/tauri-bridge：捕获 fs_append_diagnostics 调用，不真落盘
// =============================================================================
const appendCalls: Array<{ saveId: string; line: string }> = []

vi.mock('@/layers/gateway/tauri-bridge', () => ({
  fsAppendDiagnostics: vi.fn(async (saveId: string, line: string): Promise<void> => {
    appendCalls.push({ saveId, line })
  }),
}))

// 被测模块（必须在 vi.mock 之后 import）
import {
  appendDiagnostic,
  __sanitizeForTest,
} from '@/layers/persistence/diagnostics'

describe('appendDiagnostic', () => {
  beforeEach(() => {
    appendCalls.length = 0
  })

  it('经 gateway fs_append_diagnostics 落盘，序列化为一行 JSON', async () => {
    await appendDiagnostic('save-1', {
      level: 'info',
      category: 'persist',
      message: 'ok',
    })

    expect(appendCalls).toHaveLength(1)
    expect(appendCalls[0].saveId).toBe('save-1')
    // 应是一行合法 JSON
    const parsed = JSON.parse(appendCalls[0].line) as Record<string, unknown>
    expect(parsed.level).toBe('info')
    expect(parsed.category).toBe('persist')
    expect(parsed.message).toBe('ok')
    expect(typeof parsed.ts).toBe('number')
  })

  it('code 字段在传入时落盘', async () => {
    await appendDiagnostic('save-1', {
      level: 'error',
      category: 'llm/api_key',
      message: '鉴权失败',
      code: 401,
    })
    const parsed = JSON.parse(appendCalls[0].line) as Record<string, unknown>
    expect(parsed.code).toBe(401)
  })

  it('不泄露 apiKey 明文（兜底脱敏 sk- 片段）', async () => {
    const secretKey = 'sk-abcdef1234567890'
    await appendDiagnostic('save-1', {
      level: 'error',
      category: 'llm/network',
      message: `请求失败 key=${secretKey}`,
    })
    const line = appendCalls[0].line
    // 明文 key 不得出现在落盘内容中
    expect(line).not.toContain(secretKey)
    // 应被替换为脱敏占位
    expect(line).toContain('sk-***')
  })

  it('不泄露 payload 明文（apiKey= / payload= 赋值脱敏）', async () => {
    await appendDiagnostic('save-1', {
      level: 'error',
      category: 'llm/network',
      message: 'err payload={"secret":"top"} apiKey=sk-leak-xyz',
    })
    const line = appendCalls[0].line
    expect(line).not.toContain('top')
    expect(line).not.toContain('sk-leak-xyz')
  })

  it('不泄露 Bearer 令牌（含 JWT）', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.sig'
    await appendDiagnostic('save-1', {
      level: 'warn',
      category: 'llm/network',
      message: `Authorization: Bearer ${token}`,
    })
    const line = appendCalls[0].line
    // JWT/令牌明文不得残留
    expect(line).not.toContain(token)
    expect(line).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    // 应被脱敏为占位（Bearer *** 或 Authorization=***，二者皆合法）
    expect(line).toContain('***')
  })

  it('超长 message 被截断（防日志膨胀/泄漏大量上下文）', async () => {
    const longMsg = 'x'.repeat(1000)
    await appendDiagnostic('save-1', {
      level: 'info',
      category: 'persist',
      message: longMsg,
    })
    const parsed = JSON.parse(appendCalls[0].line) as Record<string, unknown>
    const msg = parsed.message as string
    expect(msg.length).toBeLessThan(longMsg.length)
    expect(msg.endsWith('…')).toBe(true)
  })
})

describe('__sanitizeForTest（脱敏纯函数）', () => {
  it('sk- / sk_ 片段脱敏', () => {
    expect(__sanitizeForTest('sk-1234567890abc')).toBe('sk-***')
    expect(__sanitizeForTest('sk_1234567890abc')).toBe('sk-***')
  })

  it('保留无害文本不变', () => {
    expect(__sanitizeForTest('writeTurn 失败: I/O error')).toBe(
      'writeTurn 失败: I/O error',
    )
  })

  it('password= / token= / secret= 赋值脱敏', () => {
    expect(__sanitizeForTest('password=hunter2')).toBe('password=***')
    expect(__sanitizeForTest('token=abc.def.ghi')).toBe('token=***')
    expect(__sanitizeForTest('secret=s3cr3t')).toBe('secret=***')
  })
})

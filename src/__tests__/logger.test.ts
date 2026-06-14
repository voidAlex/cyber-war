/**
 * 统一日志模块测试（logger.test.ts）。
 *
 * 覆盖：
 * - 脱敏：message/context 经 sanitize 剔除 apiKey/payload/Bearer/token/password 等。
 * - 路由：scope='app' → app.log；scope='save'+saveId → diagnostics.log；
 *   scope='save' 但无 saveId → 降级 app.log（best-effort 不丢日志）。
 * - best-effort：sink reject 不抛错、不阻塞调用方。
 * - console 输出：按 level 选方法（dev 全级别）。
 * - 便捷方法：logger.debug/info/warn/error 透传 level。
 * - 结构化：落盘为单行 JSON，含 ts/level/category/message/turn。
 *
 * 通过 setLogSink 注入 fake sink，捕获落盘行断言；不触达 Tauri/fetch。
 *
 * @module __tests__/logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  logger,
  log,
  setLogSink,
  __sanitizeMessageForTest,
  __sanitizeContextForTest,
  type LogSink,
} from '@/utils/logger'

// =============================================================================
// fake sink：捕获落盘行（不触达 Tauri/fetch）
// =============================================================================

interface Captured {
  appLog: string[]
  diagnostics: Array<{ saveId: string; line: string }>
}

let captured: Captured
let rejectOnce: boolean

function makeFakeSink(): LogSink {
  return {
    async appendAppLog(line) {
      if (rejectOnce) {
        rejectOnce = false
        throw new Error('mock sink reject')
      }
      captured.appLog.push(line)
    },
    async appendDiagnostics(saveId, line) {
      captured.diagnostics.push({ saveId, line })
    },
  }
}

beforeEach(() => {
  captured = { appLog: [], diagnostics: [] }
  rejectOnce = false
  setLogSink(makeFakeSink())
  // 静默 console（避免测试输出噪音），但保留可被 spying
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  // 恢复默认 gateway sink（避免影响后续测试模块）
  setLogSink(null)
  vi.restoreAllMocks()
})

describe('logger 路由（scope）', () => {
  it('scope=app → 写 app.log', async () => {
    logger.info('app/test', 'hi', { scope: 'app' })
    // 落盘是 fire-and-forget，等微任务
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(1)
    expect(captured.diagnostics).toHaveLength(0)
  })

  it('scope=save + saveId → 写对应存档 diagnostics.log', async () => {
    logger.info('orch/test', 'resolve', { scope: 'save', saveId: 'save-1', turn: 3 })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(0)
    expect(captured.diagnostics).toHaveLength(1)
    expect(captured.diagnostics[0].saveId).toBe('save-1')
  })

  it('scope=save 但无 saveId → 降级 app.log（不丢日志）', async () => {
    logger.info('orch/test', 'resolve', { scope: 'save', turn: 3 })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(1)
    expect(captured.diagnostics).toHaveLength(0)
  })

  it('默认（无 scope）→ app.log', async () => {
    logger.info('app/test', 'plain')
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(1)
  })
})

describe('logger 结构化', () => {
  it('落盘为单行合法 JSON，含 ts/level/category/message', async () => {
    logger.warn('test/cat', 'hello', { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    const line = captured.appLog[0]
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(parsed.level).toBe('warn')
    expect(parsed.category).toBe('test/cat')
    expect(parsed.message).toBe('hello')
    expect(typeof parsed.ts).toBe('number')
  })

  it('turn 字段在传入时落盘', async () => {
    logger.info('test/cat', 'turn', { scope: 'save', saveId: 's', turn: 7 })
    await new Promise((r) => setTimeout(r, 0))
    const parsed = JSON.parse(captured.diagnostics[0].line) as Record<string, unknown>
    expect(parsed.turn).toBe(7)
  })

  it('业务上下文经脱敏后写入 context 字段', async () => {
    logger.info('test/cat', 'ctx', { scope: 'app', faction: 'france', count: 5 })
    await new Promise((r) => setTimeout(r, 0))
    const parsed = JSON.parse(captured.appLog[0]) as Record<string, unknown>
    const ctx = parsed.context as Record<string, unknown>
    expect(ctx.faction).toBe('france')
    expect(ctx.count).toBe(5)
    // scope/saveId/turn 控制字段不进 context
    expect(ctx.scope).toBeUndefined()
    expect(ctx.saveId).toBeUndefined()
  })
})

describe('logger 脱敏（message）', () => {
  it('sk- API key 片段脱敏', async () => {
    logger.error('llm/test', `failed key=sk-abcdef1234567890`, { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    const line = captured.appLog[0]
    expect(line).not.toContain('sk-abcdef1234567890')
    expect(line).toContain('sk-***')
  })

  it('Bearer 令牌脱敏', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.sig'
    logger.warn('llm/test', `Authorization: Bearer ${token}`, { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    const line = captured.appLog[0]
    expect(line).not.toContain(token)
    expect(line).toContain('***')
  })

  it('apiKey= / payload= / password= 赋值脱敏', async () => {
    logger.error('test', 'err apiKey=sk-leak-xyz password=hunter2', { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    const line = captured.appLog[0]
    expect(line).not.toContain('sk-leak-xyz')
    expect(line).not.toContain('hunter2')
  })

  it('超长 message 截断', async () => {
    const long = 'x'.repeat(500)
    logger.info('test', long, { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    const parsed = JSON.parse(captured.appLog[0]) as Record<string, unknown>
    expect((parsed.message as string).length).toBeLessThan(long.length)
    expect((parsed.message as string).endsWith('…')).toBe(true)
  })
})

describe('logger 脱敏（context 深度）', () => {
  it('敏感键的值替换为 ***', async () => {
    logger.info('test', 'ctx', {
      scope: 'app',
      apiKey: 'sk-secret',
      token: 'abc',
      password: 'pw',
      safe: 'ok',
    })
    await new Promise((r) => setTimeout(r, 0))
    const ctx = JSON.parse(captured.appLog[0]).context as Record<string, unknown>
    expect(ctx.apiKey).toBe('***')
    expect(ctx.token).toBe('***')
    expect(ctx.password).toBe('***')
    expect(ctx.safe).toBe('ok')
  })

  it('嵌套对象的敏感字段也脱敏', async () => {
    logger.info('test', 'nested', {
      scope: 'app',
      request: { headers: { Authorization: 'Bearer xxx' }, body: { ok: true } },
    })
    await new Promise((r) => setTimeout(r, 0))
    const ctx = JSON.parse(captured.appLog[0]).context as Record<string, unknown>
    const req = ctx.request as Record<string, unknown>
    const headers = req.headers as Record<string, unknown>
    expect(headers.Authorization).toBe('***')
    // body 中的非敏感字段保留
    const body = req.body as Record<string, unknown>
    expect(body.ok).toBe(true)
  })

  it('数组逐项递归脱敏', async () => {
    logger.info('test', 'arr', {
      scope: 'app',
      items: [{ apiKey: 'sk-a' }, { safe: 1 }],
    })
    await new Promise((r) => setTimeout(r, 0))
    const ctx = JSON.parse(captured.appLog[0]).context as Record<string, unknown>
    const items = ctx.items as Array<Record<string, unknown>>
    expect(items[0].apiKey).toBe('***')
    expect(items[1].safe).toBe(1)
  })
})

describe('logger best-effort（落盘失败不抛错）', () => {
  it('sink reject 时调用方不抛错', async () => {
    rejectOnce = true
    expect(() => logger.info('test', 'will-reject', { scope: 'app' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    // 第一次被 reject，第二次正常
    logger.info('test', 'ok', { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(1)
  })
})

describe('logger console 输出', () => {
  it('debug 级别调 console.debug', () => {
    logger.debug('test', 'dbg', { scope: 'app' })
    expect(console.debug).toHaveBeenCalled()
  })

  it('error 级别调 console.error', () => {
    logger.error('test', 'err', { scope: 'app' })
    expect(console.error).toHaveBeenCalled()
  })

  it('warn 级别调 console.warn', () => {
    logger.warn('test', 'w', { scope: 'app' })
    expect(console.warn).toHaveBeenCalled()
  })
})

describe('logger 便捷方法', () => {
  it('debug/info/warn/error 透传对应 level', async () => {
    logger.debug('t', 'd', { scope: 'app' })
    logger.info('t', 'i', { scope: 'app' })
    logger.warn('t', 'w', { scope: 'app' })
    logger.error('t', 'e', { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(4)
    const levels = captured.appLog.map((l) => (JSON.parse(l) as { level: string }).level)
    expect(levels).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('log(level, ...) 显式入口等价于便捷方法', async () => {
    log('info', 't', 'm', { scope: 'app' })
    await new Promise((r) => setTimeout(r, 0))
    expect(captured.appLog).toHaveLength(1)
  })
})

describe('__sanitizeMessageForTest', () => {
  it('保留无害文本', () => {
    expect(__sanitizeMessageForTest('writeTurn 失败: I/O')).toBe('writeTurn 失败: I/O')
  })
  it('secret= 赋值脱敏', () => {
    expect(__sanitizeMessageForTest('secret=top')).toBe('secret=***')
  })
})

describe('__sanitizeContextForTest', () => {
  it('null/原始类型原样返回', () => {
    expect(__sanitizeContextForTest(null)).toBeNull()
    expect(__sanitizeContextForTest(42)).toBe(42)
  })
  it('长字符串截断', () => {
    const long = 'a'.repeat(300)
    const out = __sanitizeContextForTest(long) as string
    expect(out.length).toBeLessThan(long.length)
    expect(out.endsWith('…')).toBe(true)
  })
  it('函数替换为 <fn>', () => {
    const out = __sanitizeContextForTest({ fn: () => 1 }) as Record<string, unknown>
    expect(out.fn).toBe('<fn>')
  })
})

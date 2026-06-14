/**
 * llm-client IO 测试（llm-client.test.ts）— mock invoke。
 *
 * 覆盖：
 * - streamChat AsyncIterable：delta/usage/done 事件正确流转。
 * - 命中率统计：从 usage 事件提取 hit/miss tokens。
 * - error 事件 → throw LlmStreamError。
 * - degraded:true → stats.degraded=true。
 * - AbortSignal：迭代器提前 return。
 * - 回调式 streamForward 兼容。
 *
 * 用 vi.mock 替换 @tauri-apps/api/core，捕获 invoke 收到的 Channel，
 * 测试代码通过该 Channel 手动 emit LlmStreamEvent。
 *
 * @module __tests__/agents/llm-client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { LlmStreamEvent } from '@/layers/gateway/bridge-types'

// =============================================================================
// mock @tauri-apps/api/core：捕获 invoke 收到的 Channel，提供 emit 工具
// =============================================================================
//
// vi.mock 工厂会被提升到文件顶部执行，故不能在工厂内引用普通顶层声明。
// 用 vi.hoisted 把共享状态（MockChannel/invokeCalls/pendingResolve/Reject）
// 也提升到 mock 工厂之前初始化。

const hoisted = vi.hoisted(() => {
  /** 模拟 Tauri Channel：暴露 onmessage 设置点 + emit 方法 */
  class MockChannel {
    onmessage: ((event: unknown) => void) | null = null
    emit(event: unknown): void {
      // 事件循环下一 tick 触发（模拟 IPC 异步）
      queueMicrotask(() => {
        this.onmessage?.(event)
      })
    }
  }

  /** invoke 调用记录（测试断言用） */
  const invokeCalls: Array<{
    cmd: string
    args: Record<string, unknown>
    channel: MockChannel
  }> = []

  /** 当前 invoke 的 resolve/reject（测试动态设置以模拟 Rust 返回） */
  const invokeState = {
    pendingResolve: null as ((result: unknown) => void) | null,
    pendingReject: null as ((err: unknown) => void) | null,
  }

  /** mock invoke 实现：捕获 Channel，挂起 Promise 等测试 resolve/reject */
  const invokeImpl = async (
    cmd: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const channel = args.onEvent as MockChannel
    invokeCalls.push({ cmd, args, channel })
    return new Promise((resolve, reject) => {
      invokeState.pendingResolve = resolve
      invokeState.pendingReject = reject
    })
  }

  return { MockChannel, invokeCalls, invokeState, invokeImpl }
})

// 测试用引用（指向同一份提升后的状态）
const MockChannel = hoisted.MockChannel
const invokeCalls = hoisted.invokeCalls

// vi.mock 工厂（提升执行）：引用 hoisted 的 MockChannel 与 invokeImpl
vi.mock('@tauri-apps/api/core', () => ({
  Channel: hoisted.MockChannel,
  invoke: hoisted.invokeImpl,
}))

// 导入被测模块（在 mock 之后）
import {
  streamChat,
  streamForward,
  LlmStreamError,
  buildPayload,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  type StreamChatOptions,
} from '@/layers/gateway/llm-client'

// =============================================================================
// 测试辅助
// =============================================================================

beforeEach(() => {
  invokeCalls.length = 0
  hoisted.invokeState.pendingResolve = null
  hoisted.invokeState.pendingReject = null
})

/** 测试触发 invoke 成功返回（模拟 Rust 返回 LlmFinalResult） */
function resolveInvoke(result: unknown): void {
  const r = hoisted.invokeState.pendingResolve
  hoisted.invokeState.pendingResolve = null
  hoisted.invokeState.pendingReject = null
  r?.(result)
}

/** 测试触发 invoke reject（模拟 Rust 返回 Err） */
function rejectInvoke(err: unknown): void {
  const r = hoisted.invokeState.pendingReject
  hoisted.invokeState.pendingResolve = null
  hoisted.invokeState.pendingReject = null
  r?.(err)
}

function makeOpts(): StreamChatOptions {
  return {
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
  }
}

// =============================================================================
// streamChat AsyncIterable
// =============================================================================

describe('streamChat — AsyncIterable 事件流转', () => {
  it('delta/usage/done 事件按序产出', async () => {
    const handle = streamChat(makeOpts())

    // 收集事件（异步）
    const events: LlmStreamEvent[] = []
    const consumePromise = (async () => {
      for await (const ev of handle) {
        events.push(ev)
      }
    })()

    // 等待 invoke 被调用（start 懒启动，for-await 触发）
    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel

    // 手动 emit 事件（每个 emit 走 microtask）
    channel.emit({ type: 'delta', text: 'Hello' })
    channel.emit({ type: 'delta', text: ' world' })
    channel.emit({
      type: 'usage',
      promptCacheHitTokens: 100,
      promptCacheMissTokens: 20,
      inputTokens: 120,
      outputTokens: 5,
    })
    channel.emit({ type: 'done' })
    resolveInvoke({
      degraded: false,
      promptCacheHitTokens: 100,
      promptCacheMissTokens: 20,
      inputTokens: 120,
      outputTokens: 5,
    })

    await consumePromise

    expect(events.map((e) => e.type)).toEqual([
      'delta', 'delta', 'usage', 'done',
    ])
    expect(events[0]).toMatchObject({ type: 'delta', text: 'Hello' })
  })

  it('累积完整文本（所有 delta 拼接）', async () => {
    const handle = streamChat(makeOpts())
    const deltas: string[] = []
    const consumePromise = (async () => {
      for await (const ev of handle) {
        if (ev.type === 'delta') deltas.push(ev.text)
      }
    })()

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'delta', text: 'foo' })
    channel.emit({ type: 'delta', text: 'bar' })
    channel.emit({ type: 'done' })
    resolveInvoke({ degraded: false, promptCacheHitTokens: null, promptCacheMissTokens: null, inputTokens: null, outputTokens: null })

    await consumePromise
    const result = await handle.result()
    expect(result.text).toBe('foobar')
  })

  it('命中率统计：从 usage 事件提取 hit/miss tokens', async () => {
    const handle = streamChat(makeOpts())
    let usageSeen = false
    const consumePromise = (async () => {
      for await (const ev of handle) {
        if (ev.type === 'usage') usageSeen = true
      }
    })()

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'delta', text: 'x' })
    channel.emit({
      type: 'usage',
      promptCacheHitTokens: 800,
      promptCacheMissTokens: 200,
      inputTokens: 1000,
      outputTokens: 50,
    })
    channel.emit({ type: 'done' })
    resolveInvoke({ degraded: false, promptCacheHitTokens: 800, promptCacheMissTokens: 200, inputTokens: 1000, outputTokens: 50 })

    await consumePromise
    const result = await handle.result()
    expect(result.stats.promptCacheHitTokens).toBe(800)
    expect(result.stats.promptCacheMissTokens).toBe(200)
    expect(result.stats.degraded).toBe(false)
    expect(usageSeen).toBe(true)
  })

  it('error 事件 → throw LlmStreamError（迭代器 throw）', async () => {
    const handle = streamChat(makeOpts())
    // result() 会 reject（错误），但本测试只断言迭代器 throw，故吞掉 result rejection
    handle.result().catch(() => {})
    const events: LlmStreamEvent[] = []
    let thrown: unknown = null
    const consumePromise = (async () => {
      try {
        for await (const ev of handle) {
          events.push(ev)
        }
      } catch (e) {
        thrown = e
      }
    })()

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'error', kind: 'timeout', message: '请求超时' })
    rejectInvoke(new Error('invoke rejected'))

    await consumePromise

    expect(thrown).toBeInstanceOf(LlmStreamError)
    expect((thrown as LlmStreamError).kind).toBe('timeout')
  })

  it('await streamChat(opts) 直接得 StreamChatResult', async () => {
    const handle = streamChat(makeOpts())
    // 句柄本身可 await（实现 PromiseLike<StreamChatResult>）
    const resultPromise = handle.result()

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'delta', text: 'hi' })
    channel.emit({ type: 'done' })
    resolveInvoke({ degraded: false, promptCacheHitTokens: 0, promptCacheMissTokens: 10, inputTokens: 10, outputTokens: 2 })

    const result = await resultPromise
    expect(result.text).toBe('hi')
    expect(result.stats.degraded).toBe(false)
  })
})

describe('streamChat — degraded 降级信号', () => {
  it('finalResult.degraded=true 时 stats.degraded=true', async () => {
    const handle = streamChat(makeOpts())
    let doneSeen = false
    const consumePromise = (async () => {
      for await (const ev of handle) {
        if (ev.type === 'done') doneSeen = true
      }
    })()

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'delta', text: 'partial' })
    channel.emit({ type: 'done' })
    // Rust 3 次重试均失败 → degraded:true
    resolveInvoke({ degraded: true, promptCacheHitTokens: null, promptCacheMissTokens: null, inputTokens: null, outputTokens: null })

    await consumePromise
    const result = await handle.result()
    expect(result.stats.degraded).toBe(true)
    expect(doneSeen).toBe(true)
  })
})

describe('streamChat — AbortSignal', () => {
  it('abort 后迭代器提前 return（done）', async () => {
    const controller = new AbortController()
    const handle = streamChat({ ...makeOpts(), signal: controller.signal })

    const received: LlmStreamEvent[] = []
    let loopDone = false
    const consumePromise = (async () => {
      for await (const ev of handle) {
        received.push(ev)
      }
      loopDone = true
    })()

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'delta', text: 'partial' })

    // 等待 delta 事件被处理（emit 走 microtask 异步），再触发 abort
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0))
    controller.abort()

    await consumePromise
    expect(loopDone).toBe(true)
    // abort 前已产出的 delta 仍被消费
    expect(received.some((e) => e.type === 'delta')).toBe(true)
  })
})

describe('streamChat — invoke 参数对齐 commands.rs', () => {
  it('payload 含 model/messages/stream，onEvent 为 Channel', async () => {
    const handle = streamChat(makeOpts())
    handle.result().catch(() => {})

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const call = invokeCalls[0]
    expect(call.cmd).toBe('llm_stream_forward')
    expect(call.args.provider).toBe('deepseek')
    expect(call.args.endpoint).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(call.args.apiKey).toBe('sk-test')
    expect(call.args.onEvent).toBeInstanceOf(MockChannel)
    const payload = call.args.payload as Record<string, unknown>
    expect(payload.model).toBe('deepseek-v4-flash')
    expect(payload.stream).toBe(true)
  })

  it('thinking 字段透传到 payload', async () => {
    const handle = streamChat({ ...makeOpts(), thinking: { type: 'enabled' } })
    handle.result().catch(() => {})

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const payload = invokeCalls[0].args.payload as Record<string, unknown>
    expect(payload.thinking).toEqual({ type: 'enabled' })
  })
})

// =============================================================================
// 回调式 streamForward（兼容）
// =============================================================================

describe('streamForward（回调式兼容）', () => {
  it('delta/usage/done 回调触发', async () => {
    const deltas: string[] = []
    let usage: { promptCacheHitTokens: number | null } | null = null
    let done = false

    const promise = streamForward(
      { provider: 'deepseek', endpoint: 'e', apiKey: 'k', payload: {} },
      {
        onDelta: (t) => deltas.push(t),
        onUsage: (u) => { usage = u },
        onDone: () => { done = true },
      },
    )

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const channel = invokeCalls[0].channel
    channel.emit({ type: 'delta', text: 'a' })
    channel.emit({ type: 'delta', text: 'b' })
    channel.emit({ type: 'usage', promptCacheHitTokens: 5, promptCacheMissTokens: 0, inputTokens: 5, outputTokens: 1 })
    channel.emit({ type: 'done' })
    resolveInvoke({ degraded: false, promptCacheHitTokens: 5, promptCacheMissTokens: 0, inputTokens: 5, outputTokens: 1 })

    const result = await promise
    expect(deltas).toEqual(['a', 'b'])
    expect(usage).not.toBeNull()
    expect(usage!.promptCacheHitTokens).toBe(5)
    expect(done).toBe(true)
    expect(result.degraded).toBe(false)
  })
})

// =============================================================================
// P1-7：按 provider 分支构造 payload（Anthropic 顶层 system + max_tokens）
// =============================================================================

describe('buildPayload — 按 provider 分支（P1-7）', () => {
  it('deepseek：OpenAI 兼容格式（system 在 messages[0]，无 max_tokens）', () => {
    const payload = buildPayload({
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '你是导演部' },
        { role: 'user', content: '结算' },
      ],
    })
    expect(payload.model).toBe('deepseek-v4-flash')
    expect(payload.stream).toBe(true)
    // system 仍在 messages 里（OpenAI 格式）
    const msgs = payload.messages as Array<{ role: string; content: string }>
    expect(msgs[0]).toMatchObject({ role: 'system', content: '你是导演部' })
    expect(msgs[1]).toMatchObject({ role: 'user', content: '结算' })
    // 无顶层 system，无 max_tokens
    expect(payload.system).toBeUndefined()
    expect(payload.max_tokens).toBeUndefined()
  })

  it('openai：与 deepseek 同构（OpenAI 兼容）', () => {
    const payload = buildPayload({
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(payload.max_tokens).toBeUndefined()
    expect(payload.system).toBeUndefined()
    expect(payload.messages).toHaveLength(1)
  })

  it('anthropic：system 提到顶层 + 强制 max_tokens（P1-7 核心）', () => {
    const payload = buildPayload({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'sk-ant-test',
      model: 'claude-opus-4-5',
      messages: [
        { role: 'system', content: '你是导演部，负责终裁' },
        { role: 'user', content: '结算第5回合' },
      ],
    })
    expect(payload.model).toBe('claude-opus-4-5')
    expect(payload.stream).toBe(true)
    // 关键断言 1：顶层 system（从 messages[0] 提取）
    expect(payload.system).toBe('你是导演部，负责终裁')
    // 关键断言 2：强制 max_tokens（默认值）
    expect(payload.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    // 关键断言 3：messages 不再含 role:system（已提取到顶层）
    const msgs = payload.messages as Array<{ role: string }>
    expect(msgs.every((m) => m.role !== 'system')).toBe(true)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'user', content: '结算第5回合' })
  })

  it('anthropic：多条 system 消息拼接为顶层 system（用 \\n\\n 分隔）', () => {
    const payload = buildPayload({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'k',
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: '人格：冷峻参谋长' },
        { role: 'system', content: '规则：绝不伪造单位' },
        { role: 'user', content: 'go' },
      ],
    })
    expect(payload.system).toBe('人格：冷峻参谋长\n\n规则：绝不伪造单位')
    const msgs = payload.messages as Array<{ role: string }>
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(0)
  })

  it('anthropic：extraParams.max_tokens 覆盖默认值', () => {
    const payload = buildPayload({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'k',
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      extraParams: { max_tokens: 8192 },
    })
    expect(payload.max_tokens).toBe(8192)
  })

  it('anthropic：无 system 消息时不设置顶层 system（API 允许）', () => {
    const payload = buildPayload({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'k',
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: '无 system 的纯对话' }],
    })
    expect(payload.system).toBeUndefined()
    expect(payload.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
  })

  it('anthropic：thinking 透传到顶层（extended thinking）', () => {
    const payload = buildPayload({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'k',
      model: 'claude-opus-4-5',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      thinking: { type: 'enabled', budget_tokens: 5000 },
    })
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 5000 })
    expect(payload.system).toBe('s')
  })

  it('custom：走 OpenAI 兼容分支（Bearer 鉴权，无 max_tokens 强制）', () => {
    const payload = buildPayload({
      provider: 'custom',
      endpoint: 'https://my-llm.example.com/v1/chat/completions',
      apiKey: 'k',
      model: 'my-model',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(payload.max_tokens).toBeUndefined()
    expect(payload.system).toBeUndefined()
    expect(payload.messages).toHaveLength(1)
  })
})

describe('streamChat — anthropic payload 经 invoke 发出（P1-7 集成）', () => {
  it('anthropic provider 的 invoke payload 含顶层 system + max_tokens', async () => {
    const opts: StreamChatOptions = {
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'sk-ant',
      model: 'claude-opus-4-5',
      messages: [
        { role: 'system', content: '导演部人格' },
        { role: 'user', content: '结算' },
      ],
    }
    const handle = streamChat(opts)
    handle.result().catch(() => {})

    await vi.waitFor(() => expect(invokeCalls).toHaveLength(1))
    const payload = invokeCalls[0].args.payload as Record<string, unknown>
    expect(payload.system).toBe('导演部人格')
    expect(payload.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect(payload.stream).toBe(true)
    // provider 正确透传到 invoke（router.rs 据此加 x-api-key）
    expect(invokeCalls[0].args.provider).toBe('anthropic')
  })
})

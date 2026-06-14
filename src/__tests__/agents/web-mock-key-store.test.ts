/**
 * web-mock-key-store 测试（web-mock-key-store.test.ts）— 内存 localStorage stub。
 *
 * 覆盖（去口令后浏览器降级版 keyring mock）：
 * - llmKeySave：写入 localStorage，返回 backend='keyring' + warning=null（无降级）。
 * - llmKeyLoad：读 localStorage；不存在 / 纯空白返回 null（对齐 Rust trim 语义）。
 * - llmKeyDelete：删 localStorage 键（幂等）。
 * - save→load→delete 闭环。
 *
 * 测试环境（node，无 jsdom 全局）：用 Map 手动 stub `globalThis.localStorage`，
 * 满足 web-mock-key-store 的 `typeof localStorage !== 'undefined'` 防护。
 *
 * @module __tests__/agents/web-mock-key-store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  llmKeySave,
  llmKeyLoad,
  llmKeyDelete,
  __webMockKeyStoreReset,
} from '@/layers/gateway/web-mock-key-store'

// =============================================================================
// localStorage stub（Map-based，满足 web-mock-key-store 的 typeof 防护）
// =============================================================================

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  // stub globalThis.localStorage（web-mock-key-store 用 typeof 检测 + getItem/setItem/removeItem）
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  })
  __webMockKeyStoreReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// =============================================================================
// llmKeySave
// =============================================================================

describe('llmKeySave', () => {
  it('写入 localStorage，返回 backend=keyring + warning=null（mock 无降级）', async () => {
    const outcome = await llmKeySave('sk-test-123')
    expect(outcome.backend).toBe('keyring')
    expect(outcome.warning).toBeNull()
    expect(store.get('cwmock:llm-api-key')).toBe('sk-test-123')
  })

  it('多次 save 覆盖最后一次', async () => {
    await llmKeySave('sk-first')
    await llmKeySave('sk-second')
    expect(store.get('cwmock:llm-api-key')).toBe('sk-second')
  })
})

// =============================================================================
// llmKeyLoad
// =============================================================================

describe('llmKeyLoad', () => {
  it('save 后 load 读回原值', async () => {
    await llmKeySave('sk-roundtrip')
    const loaded = await llmKeyLoad()
    expect(loaded).toBe('sk-roundtrip')
  })

  it('无 key 返回 null（首次配置 / 已 delete）', async () => {
    expect(await llmKeyLoad()).toBeNull()
  })

  it('纯空白视为无 key（trim 后为空 → null，对齐 Rust 降级文件语义）', async () => {
    store.set('cwmock:llm-api-key', '   \n\t  ')
    expect(await llmKeyLoad()).toBeNull()
  })

  it('带空白的 key trim 后非空 → 返回 trimmed 值（对齐 Rust 降级文件语义）', async () => {
    store.set('cwmock:llm-api-key', '  sk-with-ws  \n')
    expect(await llmKeyLoad()).toBe('sk-with-ws')
  })
})

// =============================================================================
// llmKeyDelete
// =============================================================================

describe('llmKeyDelete', () => {
  it('删除已存在的 key', async () => {
    await llmKeySave('sk-to-delete')
    expect(store.has('cwmock:llm-api-key')).toBe(true)
    await llmKeyDelete()
    expect(store.has('cwmock:llm-api-key')).toBe(false)
    expect(await llmKeyLoad()).toBeNull()
  })

  it('删除不存在的 key 幂等（不抛错）', async () => {
    await expect(llmKeyDelete()).resolves.toBeUndefined()
  })
})

// =============================================================================
// 闭环
// =============================================================================

describe('save→load→delete 闭环', () => {
  it('完整闭环语义正确', async () => {
    // 初始无 key
    expect(await llmKeyLoad()).toBeNull()
    // save
    await llmKeySave('sk-lifecycle')
    expect(await llmKeyLoad()).toBe('sk-lifecycle')
    // delete
    await llmKeyDelete()
    expect(await llmKeyLoad()).toBeNull()
    // 再 save（重新配置场景）
    await llmKeySave('sk-new')
    expect(await llmKeyLoad()).toBe('sk-new')
  })
})

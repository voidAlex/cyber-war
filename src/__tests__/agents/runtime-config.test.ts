/**
 * runtime-config 测试（runtime-config.test.ts）— 注入 mock keyStore/configRead。
 *
 * 去口令改造后覆盖：
 * - saveConfig：apiKey→keySave（keyring/降级），非密钥字段→configWrite（明文 JSON），
 *   返回 KeyStoreOutcome；会话内存持有明文 apiKey。
 * - loadConfig：读 configWrite（无→no-config；旧 encryptedApiKey→legacy-encrypted；
 *   keyLoad null→no-api-key；正常→session.set）。
 * - 降级警告透传（keySave 返回 file_fallback + warning）。
 * - legacy/no-api-key 时 error.pending 携带非密钥字段供 UI 预填。
 * - clearSession / getSessionConfig / isSessionUnlocked。
 *
 * 纯逻辑测试：注入 mock keySave/keyLoad/configRead/configWrite。
 *
 * @module __tests__/agents/runtime-config
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  saveConfig,
  loadConfig,
  clearSession,
  getSessionConfig,
  isSessionUnlocked,
  RuntimeConfigError,
  type RuntimeLLMConfig,
  type PersistedRuntimeConfig,
} from '@/layers/gateway/runtime-config'
import type { KeyStoreOutcome } from '@/layers/gateway/tauri-bridge'

// =============================================================================
// mock keySave/keyLoad/configRead/configWrite（内存）
// =============================================================================

interface MockStore {
  /** keyring 中的 apiKey（null=无 key） */
  key: string | null
  /** config 文件原始 JSON 字符串（null=无文件） */
  configRaw: string | null
  /** keySave 返回的 outcome（默认 keyring 成功；可改为降级） */
  keySaveOutcome: KeyStoreOutcome
}

interface MockBundle extends MockStore {
  keySave: (apiKey: string) => Promise<KeyStoreOutcome>
  keyLoad: () => Promise<string | null>
  configRead: () => Promise<string | null>
  configWrite: (content: string) => Promise<void>
  setKey: (k: string | null) => void
  setConfigRaw: (c: string | null) => void
}

function makeMocks(initial?: Partial<MockStore>): MockBundle {
  const store: MockStore = {
    key: null,
    configRaw: null,
    keySaveOutcome: { backend: 'keyring', warning: null },
    ...initial,
  }

  // 返回对象的方法用闭包访问 store；属性用 getter 透传 store 的实时值
  // （避免 spread 快照导致测试读不到方法修改后的值）
  const bundle: MockBundle = {
    get key() { return store.key },
    set key(v) { store.key = v },
    get configRaw() { return store.configRaw },
    set configRaw(v) { store.configRaw = v },
    get keySaveOutcome() { return store.keySaveOutcome },
    set keySaveOutcome(v) { store.keySaveOutcome = v },
    async keySave(apiKey: string): Promise<KeyStoreOutcome> {
      store.key = apiKey
      return store.keySaveOutcome
    },
    async keyLoad(): Promise<string | null> {
      return store.key
    },
    async configRead(): Promise<string | null> {
      return store.configRaw
    },
    async configWrite(content: string): Promise<void> {
      store.configRaw = content
    },
    setKey(k) { store.key = k },
    setConfigRaw(c) { store.configRaw = c },
  }
  return bundle
}

beforeEach(() => {
  clearSession()
})

function makeConfig(): RuntimeLLMConfig {
  return {
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-v4-flash',
    apiKey: 'sk-secret-key-123',
  }
}

// =============================================================================
// saveConfig
// =============================================================================

describe('saveConfig', () => {
  it('apiKey 存 keyring，非密钥字段存 config 文件（明文 JSON，含 keyBackend）', async () => {
    const m = makeMocks()
    await saveConfig(makeConfig(), {
      keySave: m.keySave,
      configWrite: m.configWrite,
    })

    // apiKey 进 keyring mock，不进 config 文件
    expect(m.key).toBe('sk-secret-key-123')
    // config 文件含明文非密钥字段 + keyBackend，不含 apiKey
    const raw = m.configRaw!
    expect(raw).toBeDefined()
    expect(raw).not.toContain('sk-secret-key-123')
    const parsed: PersistedRuntimeConfig = JSON.parse(raw)
    expect(parsed.provider).toBe('deepseek')
    expect(parsed.model).toBe('deepseek-v4-flash')
    expect(parsed.endpoint).toContain('deepseek.com')
    expect(parsed.keyBackend).toBe('keyring')
    expect(parsed.version).toBe(2)
  })

  it('会话内存持有明文 apiKey（save 后 getSessionConfig 可取）', async () => {
    const m = makeMocks()
    await saveConfig(makeConfig(), {
      keySave: m.keySave,
      configWrite: m.configWrite,
    })
    expect(isSessionUnlocked()).toBe(true)
    expect(getSessionConfig()?.apiKey).toBe('sk-secret-key-123')
  })

  it('降级：keySave 返回 file_fallback + warning → 透传给调用方', async () => {
    const m = makeMocks({
      keySaveOutcome: {
        backend: 'file_fallback',
        warning: 'OS 凭证库不可用，apiKey 已降级为明文存储。降级文件: /tmp/api-key.txt',
      },
    })
    const outcome = await saveConfig(makeConfig(), {
      keySave: m.keySave,
      configWrite: m.configWrite,
    })
    expect(outcome.backend).toBe('file_fallback')
    expect(outcome.warning).toContain('降级')
    // config 文件 keyBackend 字段反映降级
    const parsed: PersistedRuntimeConfig = JSON.parse(m.configRaw!)
    expect(parsed.keyBackend).toBe('file_fallback')
  })
})

// =============================================================================
// loadConfig
// =============================================================================

describe('loadConfig', async () => {
  it('无配置文件 → throw no-config', async () => {
    const m = makeMocks()
    await expect(loadConfig({
      configRead: m.configRead,
      keyLoad: m.keyLoad,
    })).rejects.toSatisfy((err: unknown) => {
      return err instanceof RuntimeConfigError && err.message === 'no-config'
    })
  })

  it('正常加载：config 文件 + keyring apiKey → session.set', async () => {
    const m = makeMocks({
      key: 'sk-loaded-key',
      configRaw: JSON.stringify({
        version: 2,
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-v4-flash',
        keyBackend: 'keyring',
      }),
    })
    const cfg = await loadConfig({
      configRead: m.configRead,
      keyLoad: m.keyLoad,
    })
    expect(cfg.apiKey).toBe('sk-loaded-key')
    expect(cfg.provider).toBe('deepseek')
    expect(getSessionConfig()?.apiKey).toBe('sk-loaded-key')
    expect(isSessionUnlocked()).toBe(true)
  })

  it('旧版加密配置（含 encryptedApiKey）→ throw legacy-encrypted + pending 非密钥字段', async () => {
    const m = makeMocks({
      configRaw: JSON.stringify({
        version: 1,
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        encryptedApiKey: { version: 1, salt: 'x', nonce: 'y', cipher: 'z' },
      }),
    })
    try {
      await loadConfig({ configRead: m.configRead, keyLoad: m.keyLoad })
      expect.fail('应抛 legacy-encrypted')
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeConfigError)
      expect((err as RuntimeConfigError).message).toBe('legacy-encrypted')
      // pending 携带非密钥字段（供 UI 预填）
      expect((err as RuntimeConfigError).pending).toEqual({
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
      })
    }
  })

  it('有 config 文件但 keyring 无 apiKey → throw no-api-key + pending', async () => {
    const m = makeMocks({
      key: null,
      configRaw: JSON.stringify({
        version: 2,
        provider: 'deepseek',
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-v4-flash',
        keyBackend: 'keyring',
      }),
    })
    try {
      await loadConfig({ configRead: m.configRead, keyLoad: m.keyLoad })
      expect.fail('应抛 no-api-key')
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeConfigError)
      expect((err as RuntimeConfigError).message).toBe('no-api-key')
      expect((err as RuntimeConfigError).pending?.provider).toBe('deepseek')
    }
  })

  it('配置文件损坏（非 JSON）→ throw（描述含解析失败）', async () => {
    const m = makeMocks({ configRaw: '这不是 JSON' })
    await expect(loadConfig({
      configRead: m.configRead,
      keyLoad: m.keyLoad,
    })).rejects.toSatisfy((err: unknown) => {
      return err instanceof RuntimeConfigError && err.message.includes('解析失败')
    })
  })

  it('save 后 load 闭环（同一 mock store）', async () => {
    const m = makeMocks()
    await saveConfig(makeConfig(), {
      keySave: m.keySave,
      configWrite: m.configWrite,
    })
    // clearSession 后再 load（模拟重启）
    clearSession()
    expect(isSessionUnlocked()).toBe(false)
    const cfg = await loadConfig({
      configRead: m.configRead,
      keyLoad: m.keyLoad,
    })
    expect(cfg.apiKey).toBe('sk-secret-key-123')
    expect(isSessionUnlocked()).toBe(true)
  })
})

// =============================================================================
// clearSession / getSessionConfig
// =============================================================================

describe('clearSession', () => {
  it('清空会话后 getSessionConfig 返回 null', async () => {
    const m = makeMocks()
    await saveConfig(makeConfig(), { keySave: m.keySave, configWrite: m.configWrite })
    expect(isSessionUnlocked()).toBe(true)
    clearSession()
    expect(isSessionUnlocked()).toBe(false)
    expect(getSessionConfig()).toBeNull()
  })

  it('clearSession 不删除 keyring / config 文件（仅清内存）', async () => {
    const m = makeMocks()
    await saveConfig(makeConfig(), { keySave: m.keySave, configWrite: m.configWrite })
    clearSession()
    // keyring 仍有 key，config 文件仍存在
    expect(m.key).toBe('sk-secret-key-123')
    expect(m.configRaw).toBeDefined()
  })
})

/**
 * runtime-config 测试（runtime-config.test.ts）— 注入 mock crypto/persist。
 *
 * 覆盖：
 * - saveEncryptedConfig：apiKey 加密后落盘（明文不入 persist 内容）。
 * - unlockConfig：读盘 + 解密 → 会话内存持有；口令错/密文损坏/不存在 throw。
 * - clearSession：清空会话（apiKey 置空）。
 * - getSessionConfig / isSessionUnlocked。
 * - 存储介质：persist 内容含 encryptedApiKey（密文），不含明文 apiKey。
 *
 * 纯逻辑测试：注入 mock encrypt/decrypt/persistRead/persistWrite。
 *
 * @module __tests__/agents/runtime-config
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  saveEncryptedConfig,
  unlockConfig,
  clearSession,
  getSessionConfig,
  isSessionUnlocked,
  RuntimeConfigError,
  type EncryptFn,
  type DecryptFn,
  type PersistWriteFn,
  type PersistReadFn,
  type RuntimeLLMConfig,
  type PersistedRuntimeConfig,
} from '@/layers/gateway/runtime-config'

// =============================================================================
// mock encrypt/decrypt/persist（内存）
// =============================================================================

function makeMocks() {
  // 模拟 Rust crypto：用 passphrase 作 cipher 后缀，便于校验「口令参与加密」
  const storage = new Map<string, string>()
  let decryptShouldFail = false
  let decryptFailMessage = '口令错误'

  const encrypt: EncryptFn = async (passphrase, plaintext) => {
    // 模拟真实加密：密文不含明文（反转字符），且口令参与（影响 salt/nonce）
    const cipher = plaintext.split('').reverse().join('')
    return {
      version: 1,
      salt: `salt-${passphrase}`,
      nonce: `nonce-${passphrase}`,
      cipher,
    }
  }

  const decrypt: DecryptFn = async (_passphrase, payload) => {
    if (decryptShouldFail) throw new Error(decryptFailMessage)
    // 反转还原
    return payload.cipher.split('').reverse().join('')
  }

  const persistWrite: PersistWriteFn = async (content) => {
    storage.set('config', content)
  }

  const persistRead: PersistReadFn = async () => {
    return storage.get('config') ?? null
  }

  return {
    encrypt,
    decrypt,
    persistWrite,
    persistRead,
    storage,
    setDecryptFail(msg = '口令错误') { decryptShouldFail = true; decryptFailMessage = msg },
    setDecryptOk() { decryptShouldFail = false },
  }
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
// saveEncryptedConfig
// =============================================================================

describe('saveEncryptedConfig', () => {
  it('apiKey 加密后落盘（persist 内容含 encryptedApiKey 密文）', async () => {
    const m = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'mypass', {
      encrypt: m.encrypt,
      persistWrite: m.persistWrite,
    })

    const stored = m.storage.get('config')!
    expect(stored).toBeDefined()
    // persist 内容不含明文 apiKey
    expect(stored).not.toContain('sk-secret-key-123')
    // persist 内容含密文 cipher
    expect(stored).toContain('cipher')
  })

  it('persist 内容含明文非密钥字段（provider/endpoint/model）', async () => {
    const m = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'pass', {
      encrypt: m.encrypt,
      persistWrite: m.persistWrite,
    })
    const stored = m.storage.get('config')!
    const parsed: PersistedRuntimeConfig = JSON.parse(stored)
    expect(parsed.provider).toBe('deepseek')
    expect(parsed.model).toBe('deepseek-v4-flash')
    expect(parsed.endpoint).toContain('deepseek.com')
    expect(parsed.encryptedApiKey.cipher).toBeDefined()
    expect(parsed.version).toBe(1)
  })

  it('不同 passphrase 产生不同密文载荷（口令参与加密：salt/nonce 随口令变）', async () => {
    const m1 = makeMocks()
    const m2 = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'pass-A', { encrypt: m1.encrypt, persistWrite: m1.persistWrite })
    await saveEncryptedConfig(makeConfig(), 'pass-B', { encrypt: m2.encrypt, persistWrite: m2.persistWrite })
    const a = (JSON.parse(m1.storage.get('config')!) as PersistedRuntimeConfig).encryptedApiKey
    const b = (JSON.parse(m2.storage.get('config')!) as PersistedRuntimeConfig).encryptedApiKey
    // nonce 含 passphrase → 不同口令产生不同 nonce
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.salt).not.toBe(b.salt)
  })
})

// =============================================================================
// unlockConfig
// =============================================================================

describe('unlockConfig', () => {
  it('保存后解锁：会话内存持有明文 apiKey', async () => {
    const m = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'mypass', {
      encrypt: m.encrypt,
      persistWrite: m.persistWrite,
    })

    const config = await unlockConfig('mypass', {
      decrypt: m.decrypt,
      persistRead: m.persistRead,
    })

    expect(config.apiKey).toBe('sk-secret-key-123')
    expect(config.provider).toBe('deepseek')
    expect(getSessionConfig()?.apiKey).toBe('sk-secret-key-123')
    expect(isSessionUnlocked()).toBe(true)
  })

  it('配置不存在 → throw（不伪造）', async () => {
    const m = makeMocks()
    await expect(unlockConfig('any', {
      decrypt: m.decrypt,
      persistRead: m.persistRead,
    })).rejects.toBeInstanceOf(RuntimeConfigError)
  })

  it('口令错误 → throw（密文无法解密）', async () => {
    const m = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'correct-pass', {
      encrypt: m.encrypt,
      persistWrite: m.persistWrite,
    })

    m.setDecryptFail('解密失败')
    await expect(unlockConfig('wrong-pass', {
      decrypt: m.decrypt,
      persistRead: m.persistRead,
    })).rejects.toBeInstanceOf(RuntimeConfigError)
  })

  it('配置文件损坏（非 JSON）→ throw', async () => {
    const m = makeMocks()
    m.storage.set('config', '这不是 JSON')
    await expect(unlockConfig('pass', {
      decrypt: m.decrypt,
      persistRead: m.persistRead,
    })).rejects.toBeInstanceOf(RuntimeConfigError)
  })
})

// =============================================================================
// clearSession / getSessionConfig
// =============================================================================

describe('clearSession', () => {
  it('清空会话后 getSessionConfig 返回 null', async () => {
    const m = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'pass', { encrypt: m.encrypt, persistWrite: m.persistWrite })
    await unlockConfig('pass', { decrypt: m.decrypt, persistRead: m.persistRead })

    expect(isSessionUnlocked()).toBe(true)
    clearSession()
    expect(isSessionUnlocked()).toBe(false)
    expect(getSessionConfig()).toBeNull()
  })

  it('clearSession 不删除磁盘文件（仅清内存）', async () => {
    const m = makeMocks()
    await saveEncryptedConfig(makeConfig(), 'pass', { encrypt: m.encrypt, persistWrite: m.persistWrite })
    clearSession()
    // 磁盘仍有密文
    expect(m.storage.get('config')).toBeDefined()
  })
})

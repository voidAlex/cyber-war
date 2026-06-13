import { describe, expect, it } from 'vitest'

import { decryptApiKey, encryptApiKey } from './key-encryption'

describe('key-encryption', () => {
  it('可正确加解密 API Key', async () => {
    const plain = 'sk-test-123456'
    const passphrase = 'm4-passphrase'

    const encrypted = await encryptApiKey(plain, passphrase)
    const decrypted = await decryptApiKey(encrypted, passphrase)

    expect(decrypted).toBe(plain)
  })

  it('错误口令无法解密', async () => {
    const encrypted = await encryptApiKey('sk-test-123456', 'right-pass')
    await expect(decryptApiKey(encrypted, 'wrong-pass')).rejects.toThrow()
  })
})

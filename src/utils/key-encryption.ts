const PBKDF2_ITERATIONS = 600000
const PBKDF2_HASH = 'SHA-256'
const AES_KEY_LENGTH = 256
const SALT_BYTES = 16
const IV_BYTES = 12

export interface EncryptedApiKeyPayload {
  version: 1
  iterations: number
  hash: 'SHA-256'
  saltBase64: string
  ivBase64: string
  cipherTextBase64: string
}

export async function encryptApiKey(apiKey: string, passphrase: string): Promise<EncryptedApiKeyPayload> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveAesKey(passphrase, salt)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(apiKey))
  )

  return {
    version: 1,
    iterations: PBKDF2_ITERATIONS,
    hash: PBKDF2_HASH,
    saltBase64: toBase64(salt),
    ivBase64: toBase64(iv),
    cipherTextBase64: toBase64(new Uint8Array(encrypted)),
  }
}

export async function decryptApiKey(payload: EncryptedApiKeyPayload, passphrase: string): Promise<string> {
  const salt = fromBase64(payload.saltBase64)
  const iv = fromBase64(payload.ivBase64)
  const cipher = fromBase64(payload.cipherTextBase64)
  const key = await deriveAesKey(passphrase, salt, payload.iterations)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(cipher)
  )

  return new TextDecoder().decode(plain)
}

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return btoa(text)
}

function fromBase64(value: string): Uint8Array {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) {
    bytes[index] = raw.charCodeAt(index)
  }
  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const cloned = new Uint8Array(bytes)
  return cloned.buffer
}

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: PBKDF2_HASH,
      salt: toArrayBuffer(salt),
      iterations,
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: AES_KEY_LENGTH,
    },
    false,
    ['encrypt', 'decrypt']
  )
}

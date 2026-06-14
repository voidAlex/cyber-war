/**
 * Web mock 加密（web-mock-crypto.ts）— 浏览器降级版 crypto 层。
 *
 * 用浏览器 WebCrypto（`crypto.subtle`）实现 PBKDF2-HMAC-SHA256 + AES-256-GCM，
 * 参数与 Rust 侧（`src-tauri/src/crypto/`）**完全对齐**：
 * - PBKDF2：SHA-256，**600000 轮**，16 字节随机 salt，派生 32 字节 key。
 * - AES-256-GCM：12 字节随机 nonce，密文含 GCM 认证标签。
 * - EncryptedPayload：{ version:1, salt:b64, nonce:b64, cipher:b64 }。
 *
 * **注意：web-mock 加密的密文与 Rust 加密的密文在算法层面互通**
 * （同口令同明文，因 salt/nonce 随机故密文不同但可互相解密），
 * 但 localStorage 中的 web 加密 payload 与 Tauri 磁盘文件是两套独立存储，
 * 不要求跨环境互读（web 模式的配置只在 web 模式用）。
 *
 * 性能：600k 轮 PBKDF2 在现代浏览器约 200-500ms，可接受（仅解锁/保存配置时调用一次）。
 *
 * **不 import `@tauri-apps/api`**（保持 gateway 边界）。
 *
 * @module layers/gateway/web-mock-crypto
 */

import type { EncryptedPayload } from './bridge-types'

// =============================================================================
// 常量：对齐 Rust（crypto/kdf.rs、crypto/aead.rs）
// =============================================================================

/** PBKDF2 迭代轮次（对齐 Rust PBKDF2_ITERATIONS = 600_000） */
const PBKDF2_ITERATIONS = 600_000
/** PBKDF2 salt 长度（字节，对齐 Rust 16） */
const SALT_LEN = 16
/** AES-256-GCM nonce 长度（字节，对齐 Rust NONCE_LEN = 12） */
const NONCE_LEN = 12
/** 派生 key 长度（字节，AES-256 = 32） */
const KEY_LEN = 32
/** 格式版本（对齐 Rust EncryptedPayload.version） */
const VERSION = 1

// =============================================================================
// base64 编解码（Uint8Array <-> b64 字符串）
// =============================================================================

/**
 * 创建基于纯 ArrayBuffer 的 Uint8Array（绕开 TS 5.7+ 的 SharedArrayBuffer 泛型问题，
 * 让 Uint8Array 兼容 WebCrypto 的 BufferSource 签名）。
 * 显式标注类型参数 <ArrayBuffer>，确保 .buffer 为 ArrayBuffer 而非 ArrayBufferLike。
 */
function allocBytes(len: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(len))
}

/** Uint8Array → base64 字符串（无 padding 问题，与 Rust Base64::encode_string 对齐） */
function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** base64 字符串 → Uint8Array（基于纯 ArrayBuffer） */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = allocBytes(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * 把字节数组转为纯 ArrayBuffer（WebCrypto BufferSource）。
 *
 * TS 5.7+ 起 Uint8Array 泛型化为 `Uint8Array<ArrayBufferLike>`，而 SharedArrayBuffer
 * 不兼容 BufferSource，导致 subtle.* 调用类型报错。这里拷贝到新 ArrayBuffer 并返回
 * 其 buffer（类型为 ArrayBuffer，精确匹配 BufferSource），绕开泛型问题。
 */
function asAB(bytes: Uint8Array): ArrayBuffer {
  const out = allocBytes(bytes.length)
  out.set(bytes)
  return out.buffer
}

// =============================================================================
// 加密 / 解密（对齐 Rust crypto_encrypt_api_key / crypto_decrypt_api_key 签名）
// =============================================================================

/**
 * 用口令派生密钥并 AES-256-GCM 加密明文。
 *
 * 流程（对齐 Rust aead.rs encrypt）：
 * 1. 随机 16 字节 salt → PBKDF2-HMAC-SHA256 派生 32 字节 AES key。
 * 2. 随机 12 字节 nonce → AES-256-GCM 加密明文（密文含 GCM tag）。
 * 3. 组装 EncryptedPayload（salt/nonce/cipher 均 base64）。
 *
 * @param password 用户口令（不存储，仅作 KDF 输入）
 * @param plaintextKey 明文 API key
 * @returns EncryptedPayload（可落盘 localStorage）
 */
export async function cryptoEncryptApiKey(
  password: string,
  plaintextKey: string,
): Promise<EncryptedPayload> {
  const subtle = getCryptoSubtle()

  // 1. 随机 salt + nonce（crypto.getRandomValues 浏览器 CSPRNG）
  const salt = crypto.getRandomValues(allocBytes(SALT_LEN))
  const nonce = crypto.getRandomValues(allocBytes(NONCE_LEN))

  // 2. PBKDF2 派生密钥
  // 2a. 先导入口令为 raw key material（用于 deriveKey）
  const passwordKey = await subtle.importKey(
    'raw',
    asAB(new TextEncoder().encode(password)),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  // 2b. 派生 AES-GCM 256 位 key
  const aesKey = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: asAB(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: KEY_LEN * 8 },
    false,
    ['encrypt'],
  )

  // 3. AES-256-GCM 加密（密文末尾含 16 字节 GCM 认证标签）
  const plaintextBytes = asAB(new TextEncoder().encode(plaintextKey))
  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: asAB(nonce) },
    aesKey,
    plaintextBytes,
  )

  return {
    version: VERSION,
    salt: bytesToB64(salt),
    nonce: bytesToB64(nonce),
    cipher: bytesToB64(new Uint8Array(cipherBuf)),
  }
}

/**
 * 用口令派生密钥并 AES-256-GCM 解密密文。
 *
 * @param password 用户口令
 * @param payload EncryptedPayload（含 salt/nonce/cipher）
 * @returns 明文 API key
 * @throws 口令错误/密文损坏时抛错（GCM 认证失败；对齐 Rust Crypto error）
 */
export async function cryptoDecryptApiKey(
  password: string,
  payload: EncryptedPayload,
): Promise<string> {
  const subtle = getCryptoSubtle()

  const salt = b64ToBytes(payload.salt)
  const nonce = b64ToBytes(payload.nonce)
  const cipher = b64ToBytes(payload.cipher)

  // 1. 导入口令 + PBKDF2 派生 AES key（与 encrypt 同参数）
  const passwordKey = await subtle.importKey(
    'raw',
    asAB(new TextEncoder().encode(password)),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  const aesKey = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: asAB(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: KEY_LEN * 8 },
    false,
    ['decrypt'],
  )

  // 2. AES-GCM 解密（GCM 认证失败抛 DOMException，对应口令错/密文损坏）
  let plainBuf: ArrayBuffer
  try {
    plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv: asAB(nonce) }, aesKey, asAB(cipher))
  } catch {
    // 口令错误或密文损坏：对齐 Rust Crypto error，抛带 type 的错误
    throw {
      type: 'crypto' as const,
      message: 'web-mock: 解密失败（口令错误或密文损坏）',
    }
  }

  return new TextDecoder().decode(plainBuf)
}

// =============================================================================
// 内部工具
// =============================================================================

/** 取 WebCrypto subtle（浏览器环境；不存在则抛清晰错误） */
function getCryptoSubtle(): SubtleCrypto {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.subtle === 'undefined'
  ) {
    // 非 https / 旧浏览器 / Node 无 subtle：抛错（web 模式依赖 WebCrypto）
    // 浏览器 dev server（localhost）subtle 可用（localhost 视为安全上下文）。
    throw {
      type: 'crypto' as const,
      message:
        'web-mock: 当前环境不支持 WebCrypto (crypto.subtle)。请用 https 或 localhost。',
    }
  }
  return crypto.subtle
}

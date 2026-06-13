/**
 * 加密客户端（crypto-client.ts）— 加解密 invoke 封装。
 *
 * 封装 `crypto_encrypt_api_key` / `crypto_decrypt_api_key`，对齐 Rust crypto 模块
 * （KDF: PBKDF2-HMAC-SHA256 600000 轮；AEAD: AES-256-GCM）。
 *
 * 安全：明文即用即抛，绝不缓存到结构体/全局；密文 EncryptedPayload 可落盘。
 *
 * 里程碑：M1（API key 加解密封装就绪）。
 *
 * @module layers/gateway/crypto-client
 */

import {
  cryptoEncryptApiKey,
  cryptoDecryptApiKey,
} from './tauri-bridge'
import type { EncryptedPayload } from './bridge-types'

/**
 * 加密 API key。
 *
 * @param password 用户口令（不存储，仅作 KDF 输入）
 * @param plaintextKey 明文 API key（即用即抛，绝不缓存）
 * @returns 可落盘的 EncryptedPayload（每次生成新随机 salt+nonce）
 */
export async function encryptApiKey(
  password: string,
  plaintextKey: string,
): Promise<EncryptedPayload> {
  return cryptoEncryptApiKey(password, plaintextKey)
}

/**
 * 解密 API key。
 *
 * 明文解密后即用即抛，调用方用完即 Drop，绝不缓存到结构体/全局状态。
 *
 * @param password 用户口令
 * @param payload 已落盘的 EncryptedPayload
 * @returns 明文 API key（用完即 Drop）
 */
export async function decryptApiKey(
  password: string,
  payload: EncryptedPayload,
): Promise<string> {
  return cryptoDecryptApiKey(password, payload)
}

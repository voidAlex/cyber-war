/**
 * Web mock apiKey 凭证库（web-mock-key-store.ts）— 浏览器降级版 keyring 层。
 *
 * 在 `isWebMode()` 为 true（浏览器 vite dev，供 agent-browser 验证）时，
 * 用 **localStorage 明文** 模拟 Rust `keyring_store` 的 save/load/delete 语义。
 *
 * 与 Rust 等价性：
 * - save：写入 localStorage（明文，**仅 web mock 验证用，生产走 OS 凭证库**），
 *   返回 `{ backend: 'keyring', warning: null }`（mock 无降级，始终 keyring）。
 * - load：读 localStorage；不存在返回 null（对齐 Rust load 的 null 语义）。
 * - delete：删除 localStorage 键（幂等）。
 *
 * 安全说明：
 * - **localStorage 明文存储仅用于浏览器 vite dev 验证**，生产环境（Tauri 桌面）
 *   走 Rust keyring_store → OS 凭证库（keyring，失败降级明文文件 + 警告）。
 * - 真机不应使用 web 模式（isWebMode() 为 false 时本模块不被调用）。
 *
 * **不 import `@tauri-apps/api`**（保持 gateway 边界）。
 *
 * @module layers/gateway/web-mock-key-store
 */

import type { KeyStoreOutcome } from './tauri-bridge'

/** localStorage key（明文 apiKey，仅 web mock 验证用） */
const LS_KEY = 'cwmock:llm-api-key'

/**
 * 存 apiKey（mock：localStorage 明文，无降级）。
 *
 * @param apiKey 明文 API key
 * @returns KeyStoreOutcome（mock 始终 backend='keyring'，无降级警告）
 */
export async function llmKeySave(apiKey: string): Promise<KeyStoreOutcome> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LS_KEY, apiKey)
    } catch {
      // quota / 隐私模式：静默降级为纯内存（刷新会丢 key，但当前会话流程可用）
    }
  }
  // mock 永不降级：返回 keyring 成功（验证流程不关心 backend 细节）
  return { backend: 'keyring', warning: null }
}

/**
 * 读 apiKey（mock：localStorage 明文）。
 *
 * @returns 明文 apiKey；不存在 / 空字符串返回 null（对齐 Rust load null 语义）
 */
export async function llmKeyLoad(): Promise<string | null> {
  if (typeof localStorage === 'undefined') return null
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v === null) return null
    // 对齐 Rust trim 语义：纯空白视为无 key
    const trimmed = v.trim()
    return trimmed.length === 0 ? null : v
  } catch {
    return null
  }
}

/**
 * 删 apiKey（mock：删 localStorage 键，幂等）。
 */
export async function llmKeyDelete(): Promise<void> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LS_KEY)
    } catch {
      // ignore
    }
  }
}

// =============================================================================
// 测试/调试辅助（仅 web-mock 内部与测试用，不导出给 tauri-bridge）
// =============================================================================

/** 清空 localStorage key（调试/测试重置用） */
export function __webMockKeyStoreReset(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LS_KEY)
    } catch {
      // ignore
    }
  }
}

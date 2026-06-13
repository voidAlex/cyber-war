/**
 * Tauri IPC 桥（tauri-bridge.ts）— **唯一允许 import `@tauri-apps/api` 的层**。
 *
 * 封装 `invoke` 调用 commands.rs 的全部命令（fs_* 14 个 + crypto_* 2 个 +
 * llm_set_allowed_hosts 1 个），参数/返回值强类型化，对齐 Rust 签名与 src/types。
 *
 * 铁律（AGENTS.md）：除本目录外任何层不得直接 import `@tauri-apps/api`。
 * 上层（persistence/services 等）一律经此桥的封装函数调用。
 *
 * @module layers/gateway/tauri-bridge
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  SaveManifest,
  WorldState,
} from '@/types'
import type { EncryptedPayload } from './bridge-types'

// =============================================================================
// 类型契约：对齐 Rust 侧（crypto/aead.rs EncryptedPayload、error.rs AppError）
// =============================================================================

/**
 * Rust 统一错误（error.rs AppError）经 IPC 序列化后的形态。
 * tag=type、content=message（见 error.rs `#[serde(tag="type", content="message")]`）。
 *
 * LLM 错误的 content 为 { kind, message } 对象；Fs/Crypto/InvalidArg 的 content 为字符串。
 */
export type AppErrorPayload =
  | { type: 'fs'; message: string }
  | { type: 'llm'; message: { kind: LlmErrorKindString; message: string } }
  | { type: 'crypto'; message: string }
  | { type: 'invalid_arg'; message: string }

/** LLM 错误四分类（error.rs LlmErrorKind.as_str() 的稳定字符串契约） */
export type LlmErrorKindString = 'network' | 'api_key' | 'llm_error' | 'timeout'

export type { EncryptedPayload } from './bridge-types'

// =============================================================================
// fs 命令（14 个，对齐 commands.rs）
// =============================================================================

/** 读取 world-state.json（返回原始 JSON 字符串，Rust 不解析语义）。 */
export function fsReadWorldState(saveId: string): Promise<string> {
  return invoke<string>('fs_read_world_state', { saveId })
}

/** 原子写入 world-state.json（接收前端序列化好的 JSON 字符串）。 */
export function fsWriteWorldState(saveId: string, content: string): Promise<void> {
  return invoke<void>('fs_write_world_state', { saveId, content })
}

/** 原子写入 snapshot.json。 */
export function fsWriteSnapshot(saveId: string, content: string): Promise<void> {
  return invoke<void>('fs_write_snapshot', { saveId, content })
}

/** 真追加一行事件到 event-log.jsonl（O(1)）。 */
export function fsAppendEvent(saveId: string, line: string): Promise<void> {
  return invoke<void>('fs_append_event', { saveId, line })
}

/** 读取 event-log.jsonl 指定 offset/limit 范围的行（分页）。 */
export function fsReadEventLog(saveId: string, offset: number, limit: number): Promise<string[]> {
  return invoke<string[]>('fs_read_event_log', { saveId, offset, limit })
}

/** 原子写入阵营文件 factions/<faction_id>.json。 */
export function fsWriteFactionFile(saveId: string, factionId: string, content: string): Promise<void> {
  return invoke<void>('fs_write_faction_file', { saveId, factionId, content })
}

/** 真追加一行到 diagnostics.log（只写 status code / 类别，绝不写 key/payload）。 */
export function fsAppendDiagnostics(saveId: string, line: string): Promise<void> {
  return invoke<void>('fs_append_diagnostics', { saveId, line })
}

/** 原子写入 manifest.json。 */
export function fsWriteManifest(saveId: string, content: string): Promise<void> {
  return invoke<void>('fs_write_manifest', { saveId, content })
}

/** 列出所有存档的 saveId（扫描 saves 根目录下含 manifest.json 的子目录）。 */
export function fsListSaves(): Promise<string[]> {
  return invoke<string[]>('fs_list_saves')
}

/** 初始化存档目录（创建 saves/<saveId> 及标准子目录，写入 manifest）。 */
export function fsInitSave(saveId: string, manifest: string): Promise<void> {
  return invoke<void>('fs_init_save', { saveId, manifest })
}

/** 删除存档目录（递归删除 saves/<saveId>）。 */
export function fsDeleteSave(saveId: string): Promise<void> {
  return invoke<void>('fs_delete_save', { saveId })
}

/** 解包战役包 ZIP 到 saves/<saveId>/campaign/（防 zip-slip）。 */
export function fsUnpackCampaign(saveId: string, zipPath: string): Promise<void> {
  return invoke<void>('fs_unpack_campaign', { saveId, zipPath })
}

/** 导出存档为 ZIP（把 saves/<saveId> 整个打包到 outZipPath）。 */
export function fsExportSave(saveId: string, outZipPath: string): Promise<void> {
  return invoke<void>('fs_export_save', { saveId, outZipPath })
}

/** 导入存档 ZIP 到一个新 saveId（解包到 saves/<newSaveId>）。 */
export function fsImportSave(newSaveId: string, zipPath: string): Promise<void> {
  return invoke<void>('fs_import_save', { newSaveId, zipPath })
}

// =============================================================================
// crypto 命令（2 个，对齐 commands.rs）
// =============================================================================

/** 加密 API key（返回可落盘的 EncryptedPayload；明文即用即抛，Rust 不缓存）。 */
export function cryptoEncryptApiKey(password: string, plaintextKey: string): Promise<EncryptedPayload> {
  return invoke<EncryptedPayload>('crypto_encrypt_api_key', { password, plaintextKey })
}

/** 解密 API key（明文解密后即用即抛，绝不缓存）。 */
export function cryptoDecryptApiKey(password: string, payload: EncryptedPayload): Promise<string> {
  return invoke<string>('crypto_decrypt_api_key', { password, payload })
}

// =============================================================================
// llm 辅助命令（host 白名单；流式转发主体见 llm-client.ts）
// =============================================================================

/** 更新 LLM host 白名单（custom provider 用，由前端 settings 注入）。 */
export function llmSetAllowedHosts(hosts: string[]): Promise<void> {
  return invoke<void>('llm_set_allowed_hosts', { hosts })
}

// =============================================================================
// 便捷工具：把 gateway 错误统一收拢为 AppErrorPayload（上层按 type 分流）
// =============================================================================

/**
 * 判断 Tauri invoke 抛出的错误是否为 AppErrorPayload 形态。
 * 上层 catch 后用此函数收拢，再按 error.type 决定降级策略。
 */
export function isAppErrorPayload(err: unknown): err is AppErrorPayload {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    'message' in err &&
    (err.type === 'fs' ||
      err.type === 'llm' ||
      err.type === 'crypto' ||
      err.type === 'invalid_arg')
  )
}

/**
 * 高层便捷：读取并解析 world-state.json 为 WorldState（含 JSON 解析）。
 * 抛错时上层用 isAppErrorPayload 收拢。
 */
export async function readWorldStateParsed(saveId: string): Promise<WorldState> {
  const raw = await fsReadWorldState(saveId)
  return JSON.parse(raw) as WorldState
}

/**
 * 高层便捷：序列化 manifest 并写入。
 */
export async function writeManifest(saveId: string, manifest: SaveManifest): Promise<void> {
  await fsWriteManifest(saveId, JSON.stringify(manifest))
}

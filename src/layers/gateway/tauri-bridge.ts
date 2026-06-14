/**
 * Tauri IPC 桥（tauri-bridge.ts）— **唯一允许 import `@tauri-apps/api` 的层**。
 *
 * 封装 `invoke` 调用 commands.rs 的全部命令（fs_* 14 个 +
 * llm_key_* 3 个 + llm_config_* 2 个 + llm_set_allowed_hosts 1 个），
 * 参数/返回值强类型化，对齐 Rust 签名与 src/types。
 *
 * 铁律（AGENTS.md）：除本目录外任何层不得直接 import `@tauri-apps/api`。
 * 上层（persistence/services 等）一律经此桥的封装函数调用。
 *
 * 去口令改造（robust-spinning-lampson「后续优化」）：旧 crypto_encrypt/decrypt_api_key
 * 已删；apiKey 经 OS 凭证库（keyring）存取，非密钥字段经 llm_config_* 明文 JSON 落盘。
 *
 * @module layers/gateway/tauri-bridge
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  SaveManifest,
  WorldState,
} from '@/types'
// web 模式降级：isWebMode() 为 true 时改走 mock 实现（浏览器 vite dev 用）。
// 这些 import 仅作为分支调用，Tauri 生产（isWebMode() false）完全不走。
import { isWebMode } from './web-mode'
import * as webFs from './web-mock-fs'
import * as webKeyStore from './web-mock-key-store'

// =============================================================================
// 类型契约：对齐 Rust 侧（error.rs AppError、commands.rs KeyStoreOutcome）
// =============================================================================

/**
 * Rust 统一错误（error.rs AppError）经 IPC 序列化后的形态。
 * tag=type、content=message（见 error.rs `#[serde(tag="type", content="message")]`）。
 *
 * LLM 错误的 content 为 { kind, message } 对象；Fs/Crypto/InvalidArg 的 content 为字符串。
 * 注：去口令后 AppError::Crypto 变体保留（降级兜底路径仍用），但前端不再发起 crypto_*。
 */
export type AppErrorPayload =
  | { type: 'fs'; message: string }
  | { type: 'llm'; message: { kind: LlmErrorKindString; message: string } }
  | { type: 'crypto'; message: string }
  | { type: 'invalid_arg'; message: string }

/** LLM 错误四分类（error.rs LlmErrorKind.as_str() 的稳定字符串契约） */
export type LlmErrorKindString = 'network' | 'api_key' | 'llm_error' | 'timeout'

/**
 * apiKey 存储结果（对齐 commands.rs `KeyStoreOutcome`）。
 *
 * - backend：实际落盘后端（"keyring" 或 "file_fallback"）。
 * - warning：降级时的警告文案（含失败原因 + 降级文件路径，**绝不包含 apiKey**）。
 *   keyring 成功时为 null。
 */
export interface KeyStoreOutcome {
  /** 存储后端标识（前端 UI 据此提示降级警告） */
  backend: 'keyring' | 'file_fallback'
  /** 降级警告（仅 file_fallback 时有值；keyring 成功为 null） */
  warning: string | null
}

// =============================================================================
// fs 命令（14 个，对齐 commands.rs）
// =============================================================================

/** 读取 world-state.json（返回原始 JSON 字符串，Rust 不解析语义）。 */
export function fsReadWorldState(saveId: string): Promise<string> {
  // web 模式（浏览器 vite dev）：走内存 mock fs
  if (isWebMode()) return webFs.fsReadWorldState(saveId)
  return invoke<string>('fs_read_world_state', { saveId })
}

/** 原子写入 world-state.json（接收前端序列化好的 JSON 字符串）。 */
export function fsWriteWorldState(saveId: string, content: string): Promise<void> {
  if (isWebMode()) return webFs.fsWriteWorldState(saveId, content)
  return invoke<void>('fs_write_world_state', { saveId, content })
}

/** 原子写入 snapshot.json。 */
export function fsWriteSnapshot(saveId: string, content: string): Promise<void> {
  if (isWebMode()) return webFs.fsWriteSnapshot(saveId, content)
  return invoke<void>('fs_write_snapshot', { saveId, content })
}

/** 读取 snapshot.json 全文（回放/崩溃恢复取最近快照；不存在则 reject）。 */
export function fsReadSnapshot(saveId: string): Promise<string> {
  if (isWebMode()) return webFs.fsReadSnapshot(saveId)
  return invoke<string>('fs_read_snapshot', { saveId })
}

/** 真追加一行事件到 event-log.jsonl（O(1)）。 */
export function fsAppendEvent(saveId: string, line: string): Promise<void> {
  if (isWebMode()) return webFs.fsAppendEvent(saveId, line)
  return invoke<void>('fs_append_event', { saveId, line })
}

/** 读取 event-log.jsonl 指定 offset/limit 范围的行（分页）。 */
export function fsReadEventLog(saveId: string, offset: number, limit: number): Promise<string[]> {
  if (isWebMode()) return webFs.fsReadEventLog(saveId, offset, limit)
  return invoke<string[]>('fs_read_event_log', { saveId, offset, limit })
}

/** 原子写入阵营文件 factions/<faction_id>.json。 */
export function fsWriteFactionFile(saveId: string, factionId: string, content: string): Promise<void> {
  if (isWebMode()) return webFs.fsWriteFactionFile(saveId, factionId, content)
  return invoke<void>('fs_write_faction_file', { saveId, factionId, content })
}

/** 真追加一行到 diagnostics.log（只写 status code / 类别，绝不写 key/payload）。 */
export function fsAppendDiagnostics(saveId: string, line: string): Promise<void> {
  if (isWebMode()) return webFs.fsAppendDiagnostics(saveId, line)
  return invoke<void>('fs_append_diagnostics', { saveId, line })
}

/**
 * 真追加一行到全局应用日志 `<app_data_dir>/logs/app.log`（跨存档）。
 *
 * 用于跨存档的全局事件（启动、配置加载/降级/legacy、致命错误、未捕获异常），
 * 与存档级 diagnostics.log 互补。零业务逻辑：Rust 仅 ensure logs 目录 + 追加。
 * 安全：line 由前端 logger 脱敏后序列化的 JSON，Rust 不解析内容。
 */
export function fsAppendAppLog(line: string): Promise<void> {
  if (isWebMode()) return webFs.fsAppendAppLog(line)
  return invoke<void>('fs_append_app_log', { line })
}

/** 原子写入 manifest.json。 */
export function fsWriteManifest(saveId: string, content: string): Promise<void> {
  if (isWebMode()) return webFs.fsWriteManifest(saveId, content)
  return invoke<void>('fs_write_manifest', { saveId, content })
}

/** 列出所有存档的 saveId（扫描 saves 根目录下含 manifest.json 的子目录）。 */
export function fsListSaves(): Promise<string[]> {
  if (isWebMode()) return webFs.fsListSaves()
  return invoke<string[]>('fs_list_saves')
}

/** 初始化存档目录（创建 saves/<saveId> 及标准子目录，写入 manifest）。 */
export function fsInitSave(saveId: string, manifest: string): Promise<void> {
  if (isWebMode()) return webFs.fsInitSave(saveId, manifest)
  return invoke<void>('fs_init_save', { saveId, manifest })
}

/** 删除存档目录（递归删除 saves/<saveId>）。 */
export function fsDeleteSave(saveId: string): Promise<void> {
  if (isWebMode()) return webFs.fsDeleteSave(saveId)
  return invoke<void>('fs_delete_save', { saveId })
}

/** 解包战役包 ZIP 到 saves/<saveId>/campaign/（防 zip-slip）。 */
export function fsUnpackCampaign(saveId: string, zipPath: string): Promise<void> {
  if (isWebMode()) return webFs.fsUnpackCampaign(saveId, zipPath)
  return invoke<void>('fs_unpack_campaign', { saveId, zipPath })
}

/** 导出存档为 ZIP（把 saves/<saveId> 整个打包到 outZipPath）。 */
export function fsExportSave(saveId: string, outZipPath: string): Promise<void> {
  if (isWebMode()) return webFs.fsExportSave(saveId, outZipPath)
  return invoke<void>('fs_export_save', { saveId, outZipPath })
}

/** 导入存档 ZIP 到一个新 saveId（解包到 saves/<newSaveId>）。 */
export function fsImportSave(newSaveId: string, zipPath: string): Promise<void> {
  if (isWebMode()) return webFs.fsImportSave(newSaveId, zipPath)
  return invoke<void>('fs_import_save', { newSaveId, zipPath })
}

// =============================================================================
// llm key / config 命令（5 个，去口令改造后替代旧 crypto_*）
// =============================================================================
//
// 设计（去口令 A/B）：apiKey 经 OS 凭证库存取（keyring + 降级明文文件兜底），
// 非密钥字段（provider/endpoint/model）经 llm_config_* 明文 JSON 原子写。
// 应用层不再有 passphrase，桌面端无口令、重启自动加载。

/**
 * 存 apiKey 到 OS 凭证库（keyring 失败时降级明文文件 + 警告）。
 *
 * @param apiKey 明文 API key（即用即抛，Rust 不缓存、不写日志）
 * @returns KeyStoreOutcome（backend + 可选降级警告）
 */
export function llmKeySave(apiKey: string): Promise<KeyStoreOutcome> {
  if (isWebMode()) return webKeyStore.llmKeySave(apiKey)
  return invoke<KeyStoreOutcome>('llm_key_save', { apiKey })
}

/**
 * 读 apiKey（先 keyring，NoEntry/Error 再试降级文件）。
 *
 * @returns 明文 apiKey；无 key 返回 null（首次配置 / 已 delete）
 */
export function llmKeyLoad(): Promise<string | null> {
  if (isWebMode()) return webKeyStore.llmKeyLoad()
  return invoke<string | null>('llm_key_load')
}

/**
 * 删 apiKey（幂等：keyring entry + 降级文件都清）。
 *
 * 前端"重新配置"流程调用：先 delete 旧 key，再 save 新 key。
 */
export function llmKeyDelete(): Promise<void> {
  if (isWebMode()) return webKeyStore.llmKeyDelete()
  return invoke<void>('llm_key_delete')
}

/**
 * 读 LLM 配置文件 `<config>/llm-config.json`（非密钥字段：provider/endpoint/model）。
 *
 * @returns 原始 JSON 字符串（Rust 不解析语义）；文件不存在返回 null
 */
export function llmConfigRead(): Promise<string | null> {
  if (isWebMode()) return webFs.llmConfigRead()
  return invoke<string | null>('llm_config_read')
}

/**
 * 原子写 LLM 配置文件 `<config>/llm-config.json`（非密钥字段，明文 JSON）。
 *
 * @param content 序列化好的 JSON 字符串（PersistedRuntimeConfig）
 */
export function llmConfigWrite(content: string): Promise<void> {
  if (isWebMode()) return webFs.llmConfigWrite(content)
  return invoke<void>('llm_config_write', { content })
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

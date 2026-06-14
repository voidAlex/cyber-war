/**
 * Runtime LLM 配置与会话管理（runtime-config.ts）— gateway IO 层。
 *
 * 去口令改造（robust-spinning-lampson「后续优化」）后：
 * - **无应用层 passphrase**，桌面端无口令、重启自动加载。
 * - apiKey 经 OS 凭证库存取（`llm_key_save`/`llm_key_load`/`llm_key_delete`），
 *   keyring 失败时 Rust 自动降级明文文件并返回 `KeyStoreOutcome.warning`。
 * - 非密钥字段（provider/endpoint/model）经 `llm_config_write`/`llm_config_read`
 *   明文 JSON 落盘 `<config>/llm-config.json`（Rust 原子写）。
 * - **仅会话内内存持有明文 apiKey**（解锁后存内存，clearSession() 清空）。
 *
 * 错误码（`RuntimeConfigError.message`）：
 * - `'no-config'`：未找到配置文件（首次使用）。
 * - `'legacy-encrypted'`：检测到旧版 `encryptedApiKey` 字段（口令已废弃），需重输 apiKey。
 * - `'no-api-key'`：有非密钥字段配置但 keyring 无 apiKey（需重输 apiKey）。
 *
 * 安全：
 * - apiKey 明文仅会话内存，clearSession 立即置空。
 * - apiKey 不进 store state 持久字段、不写文件（keyring/降级除外）。
 * - 非密钥字段明文落盘（无敏感性）。
 *
 * @module layers/gateway/runtime-config
 */

import type { ProviderKindString } from './bridge-types'
import {
  llmKeySave,
  llmKeyLoad,
  llmConfigRead,
  llmConfigWrite,
  type KeyStoreOutcome,
} from './tauri-bridge'

// =============================================================================
// 类型契约
// =============================================================================

/** 玩家运行时 LLM 配置（明文，含 apiKey） */
export interface RuntimeLLMConfig {
  /** provider 标识 */
  provider: ProviderKindString
  /** endpoint URL */
  endpoint: string
  /** 模型名 */
  model: string
  /** API key（明文，仅会话内存持有） */
  apiKey: string
}

/**
 * 落盘形态：非密钥字段明文 JSON（去口令后无 encryptedApiKey）。
 *
 * 旧版字段 `encryptedApiKey` 不再写入；loadConfig 检测到旧字段时抛
 * `legacy-encrypted`，引导用户重新输入 apiKey（一次性迁移）。
 */
export interface PersistedRuntimeConfig {
  /** 配置格式版本 */
  version: number
  /** 明文非密钥字段（provider/endpoint/model，无需加密） */
  provider: ProviderKindString
  endpoint: string
  model: string
  /**
   * apiKey 实际落盘后端（去口令后保留，UI 据此提示降级警告）。
   * 旧版配置无此字段时为 undefined（loadConfig 兼容读取）。
   */
  keyBackend?: 'keyring' | 'file_fallback'
}

/** 当前配置格式版本（向前兼容字段） */
const RUNTIME_CONFIG_VERSION = 2

// =============================================================================
// 会话状态（内存，clearSession 清空）
// =============================================================================

/** 运行时配置会话（内存持有明文 apiKey，clearSession 置空） */
class RuntimeConfigSession {
  private current: RuntimeLLMConfig | null = null

  /** 当前已加载的配置（未加载返回 null） */
  get(): RuntimeLLMConfig | null {
    return this.current
  }

  /** 设置会话配置（加载/保存成功后调用） */
  set(config: RuntimeLLMConfig): void {
    this.current = { ...config }
  }

  /** 清空会话（apiKey 明文立即置空） */
  clear(): void {
    if (this.current) {
      // 显式置空 apiKey，减少明文在内存驻留时间
      this.current.apiKey = ''
      this.current = null
    }
  }

  get isUnlocked(): boolean {
    return this.current !== null
  }
}

/** 进程内单例会话（apiKey 仅存此内存，绝不写明文磁盘） */
const session = new RuntimeConfigSession()

// =============================================================================
// 对外 API
// =============================================================================

/**
 * 保存配置（无口令）。
 *
 * 流程：
 * 1. apiKey → `llm_key_save`（keyring，失败 Rust 自动降级明文文件 + 警告）。
 * 2. 非密钥字段 → `llm_config_write`（明文 JSON，含 keyBackend）。
 * 3. session.set（会话内存持有明文 apiKey）。
 *
 * @param config 明文配置（含 apiKey）
 * @param injects 可选注入（测试用）
 * @returns KeyStoreOutcome（backend + 可选降级警告）
 */
export async function saveConfig(
  config: RuntimeLLMConfig,
  injects?: {
    keySave?: (apiKey: string) => Promise<KeyStoreOutcome>
    configWrite?: (content: string) => Promise<void>
  },
): Promise<KeyStoreOutcome> {
  const keySave = injects?.keySave ?? llmKeySave
  const configWrite = injects?.configWrite ?? llmConfigWrite

  // 1. apiKey 存 OS 凭证库（keyring / 降级明文文件）
  const outcome = await keySave(config.apiKey)

  // 2. 非密钥字段明文落盘（含 keyBackend 供 UI 提示降级）
  const persisted: PersistedRuntimeConfig = {
    version: RUNTIME_CONFIG_VERSION,
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    keyBackend: outcome.backend,
  }
  await configWrite(JSON.stringify(persisted))

  // 3. 会话内存持有明文 apiKey（即用即抛，clearSession 置空）
  session.set(config)

  return outcome
}

/**
 * 加载配置（启动自动调用，无口令）。
 *
 * 流程：
 * 1. 读 `llm_config_read`（非密钥字段 JSON）。
 *    - null → throw `'no-config'`（首次配置）。
 *    - 含旧 `encryptedApiKey` 字段 → throw `'legacy-encrypted'`（一次性迁移）。
 * 2. 读 `llm_key_load`（apiKey）。
 *    - null → throw `'no-api-key'`（需重输 apiKey）。
 * 3. session.set（会话内存持有明文 apiKey）。
 *
 * @param injects 可选注入（测试用）
 * @returns 加载后的明文配置（同时已存入会话内存）
 * @throws RuntimeConfigError（message 为错误码：no-config/legacy-encrypted/no-api-key）
 */
export async function loadConfig(
  injects?: {
    configRead?: () => Promise<string | null>
    keyLoad?: () => Promise<string | null>
  },
): Promise<RuntimeLLMConfig> {
  const configRead = injects?.configRead ?? llmConfigRead
  const keyLoad = injects?.keyLoad ?? llmKeyLoad

  // 1. 读非密钥字段配置文件
  const raw = await configRead()
  if (raw === null) {
    throw new RuntimeConfigError('no-config')
  }

  let persisted: PersistedRuntimeConfig
  try {
    persisted = JSON.parse(raw) as PersistedRuntimeConfig
  } catch (e) {
    throw new RuntimeConfigError(
      `配置文件损坏（JSON 解析失败）: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // 检测旧版加密配置（含 encryptedApiKey 字段）→ 引导重输 apiKey
  // 挂上读到的非密钥字段供 UI 预填（旧文件 provider/endpoint/model 明文仍可用）
  if (
    typeof (persisted as { encryptedApiKey?: unknown }).encryptedApiKey !== 'undefined'
  ) {
    throw new RuntimeConfigError('legacy-encrypted', {
      provider: persisted.provider,
      endpoint: persisted.endpoint,
      model: persisted.model,
    })
  }

  // 2. 读 apiKey（keyring / 降级文件）
  const apiKey = await keyLoad()
  if (apiKey === null) {
    // 挂上读到的非密钥字段供 UI 预填（用户只需重输 apiKey）
    throw new RuntimeConfigError('no-api-key', {
      provider: persisted.provider,
      endpoint: persisted.endpoint,
      model: persisted.model,
    })
  }

  // 3. 会话内存持有明文 apiKey
  const config: RuntimeLLMConfig = {
    provider: persisted.provider,
    endpoint: persisted.endpoint,
    model: persisted.model,
    apiKey,
  }
  session.set(config)
  return config
}

/**
 * 清空会话（apiKey 明文立即置空）。
 * 不删除磁盘文件 / keyring entry（仅清内存）。
 */
export function clearSession(): void {
  session.clear()
}

/**
 * 获取当前会话配置（未加载返回 null）。
 * 用于 Agent 编排时取 apiKey 发起 LLM 请求。
 */
export function getSessionConfig(): RuntimeLLMConfig | null {
  return session.get()
}

/** 是否已加载（会话内存持有明文 apiKey） */
export function isSessionUnlocked(): boolean {
  return session.isUnlocked
}

// =============================================================================
// typed error
// =============================================================================

/**
 * 读到的非密钥字段视图（legacy/no-api-key 时挂在 error 上供 UI 预填表单）。
 * 不含 apiKey（无法解密 / keyring 无记录）。
 */
export interface PendingConfigView {
  provider: ProviderKindString
  endpoint: string
  model: string
}

/**
 * 运行时配置错误。
 *
 * message 为错误码或描述：
 * - `'no-config'`：未找到配置（首次使用）。
 * - `'legacy-encrypted'`：检测到旧版加密配置（口令已废弃），需重输 apiKey。
 * - `'no-api-key'`：有配置但 keyring 无 apiKey（需重输 apiKey）。
 * - 其他字符串：配置损坏等异常描述。
 *
 * `pending`：legacy-encrypted / no-api-key 时携带读到的非密钥字段（供 UI 预填表单）。
 */
export class RuntimeConfigError extends Error {
  /** legacy/no-api-key 时从旧 config 文件读到的非密钥字段（UI 预填用） */
  readonly pending: PendingConfigView | null

  constructor(message: string, pending: PendingConfigView | null = null) {
    super(message)
    this.name = 'RuntimeConfigError'
    this.pending = pending
  }
}

// 便于测试：导出常量（不破坏封装，仅测试模块用）
export const __testDefaults = {
  RUNTIME_CONFIG_VERSION,
}

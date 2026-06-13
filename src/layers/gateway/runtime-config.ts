/**
 * Runtime LLM 配置加密与会话管理（runtime-config.ts）— gateway IO 层。
 *
 * 玩家配置 {provider, endpoint, apiKey, model} + passphrase。
 *
 * 存储/加载模型：
 * - **仅会话内内存持有明文 apiKey**（解锁后存内存，clearSession() 清空，绝不写明文磁盘）。
 * - 落盘形态：整份配置（含 apiKey）经 Rust `crypto_encrypt_api_key` 加密成
 *   EncryptedPayload，序列化后存到本地固定路径。
 *
 * 存储介质选择（务实决策，见文末「存储介质说明」）：
 * 当前 Rust fs_* 命令全部以 saveId 为根。本模块复用现有 fs 命令把加密后的配置
 * JSON blob 写入一个**专用伪 saveId**（`__runtime_llm_config__`）下的固定文件，
 * 而非新增 Rust 命令。这样：
 * 1. 复用已上线的原子写（临时文件 + rename）与防目录穿越校验。
 * 2. 不引入新 command，降低 M3 阻塞面。
 * 3. 加密 payload 本身密文，磁盘上无明文 apiKey。
 *
 * 未来若需将配置移出 saves 目录（如改放 app_data_dir/config/），只需替换注入的
 * persist 函数，runtime-config 业务逻辑（加密/会话/清理）不变。
 *
 * 安全：
 * - apiKey 明文仅会话内存，clearSession 立即置空。
 * - passphrase 不存储（仅作 KDF 输入）。
 * - 解锁失败（口令错/密文损坏）抛 typed error，绝不返回伪造配置。
 *
 * @module layers/gateway/runtime-config
 */

import type { EncryptedPayload, ProviderKindString } from './bridge-types'

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

/** 落盘形态：加密后的配置（密文 payload + 明文非密钥字段） */
export interface PersistedRuntimeConfig {
  /** 配置格式版本 */
  version: number
  /** 明文非密钥字段（provider/endpoint/model，无需加密） */
  provider: ProviderKindString
  endpoint: string
  model: string
  /** apiKey 的加密 payload（密文，含 salt/nonce/cipher） */
  encryptedApiKey: EncryptedPayload
}

/** 加密函数签名（注入：默认用 gateway crypto-client，测试可 mock） */
export type EncryptFn = (
  passphrase: string,
  plaintext: string,
) => Promise<EncryptedPayload>

/** 解密函数签名（注入） */
export type DecryptFn = (
  passphrase: string,
  payload: EncryptedPayload,
) => Promise<string>

/** 持久化写入函数签名（注入：把序列化好的字符串写入固定路径） */
export type PersistWriteFn = (content: string) => Promise<void>

/** 持久化读取函数签名（注入：从固定路径读字符串，不存在返回 null） */
export type PersistReadFn = () => Promise<string | null>

// =============================================================================
// 默认持久化：复用现有 fs 命令把加密 blob 写入专用伪 saveId
// =============================================================================
//
// 存储介质说明：
// 当前所有 Rust fs_* 命令以 saveId 为根目录。为不新增 Rust 命令（降低 M3 阻塞），
// 本模块把加密后的配置 JSON blob 写入一个专用伪 saveId `__runtime_llm_config__`
// 下的 manifest.json（复用 fs_write_manifest 的原子写能力）。
//
// 该伪 saveId 仅存这一份加密配置文件，与游戏存档（saves/<saveId>/）隔离：
// - fs_list_saves 仅收录含 manifest.json 的目录 → 该伪 saveId 会被列出，
//   M3 暂可接受（配置目录与存档目录在 saves/ 下；后续可加 Rust 命令迁出）。
// - 配置文件内容是密文（encryptedApiKey），磁盘无明文 apiKey。
//
// 升级路径（非 M3 阻塞）：未来加一个 Rust 命令
// `fs_write_runtime_config(content)` 直接写 app_data_dir/config/llm-config.json，
// 替换本模块注入的 persist 函数即可，业务逻辑零改动。

import { cryptoEncryptApiKey, cryptoDecryptApiKey } from './tauri-bridge'
import {
  fsWriteManifest,
  fsInitSave,
  fsReadWorldState,
} from './tauri-bridge'

/** 专用伪 saveId（仅字母数字下划线，通过 Rust validate_save_id 校验） */
const RUNTIME_CONFIG_SAVE_ID = '__runtime_llm_config__'

/** 当前配置格式版本（向前兼容字段） */
const RUNTIME_CONFIG_VERSION = 1

/**
 * 默认 persist 写入：初始化伪 saveId 目录 + 原子写 manifest。
 *
 * 注意：fs_init_save 需要合法 manifest JSON（含 scenarioId/displayName/scenarioSeed），
 * 这里构造一份最小合法 manifest。配置文件本身存到 manifest.json（复用其原子写能力）。
 *
 * 设计权衡：复用现有 command 避免新增 Rust 代码；代价是配置文件命名借用 manifest.json。
 * 升级时换 persist 函数即可改名。
 */
async function defaultPersistWrite(content: string): Promise<void> {
  // 先确保目录存在（init 创建 saves/<id>/ + 子目录 + manifest）
  const initManifest = JSON.stringify({
    scenarioId: '__runtime_llm_config__',
    displayName: 'LLM Runtime Config',
    scenarioSeed: '__runtime_config__',
    createdAt: 0,
  })
  await fsInitSave(RUNTIME_CONFIG_SAVE_ID, initManifest)
  // 用 manifest.json 的原子写能力写加密配置 blob（覆盖 init 写的占位 manifest）
  await fsWriteManifest(RUNTIME_CONFIG_SAVE_ID, content)
}

/** 默认 persist 读取：从伪 saveId 读配置 blob（不存在返回 null） */
async function defaultPersistRead(): Promise<string | null> {
  try {
    const content = await fsReadWorldState(RUNTIME_CONFIG_SAVE_ID)
    return content
  } catch {
    // 不存在（首次启动）→ 返回 null
    return null
  }
}

// =============================================================================
// 会话状态（内存，clearSession 清空）
// =============================================================================

/** 运行时配置会话（内存持有明文 apiKey，clearSession 置空） */
class RuntimeConfigSession {
  private current: RuntimeLLMConfig | null = null

  /** 当前已解锁的配置（未解锁返回 null） */
  get(): RuntimeLLMConfig | null {
    return this.current
  }

  /** 设置会话配置（解锁成功后调用） */
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
 * 保存并加密配置（落盘）。
 *
 * 流程：apiKey 经 Rust crypto_encrypt_api_key 加密 → 与明文非密钥字段拼成
 * PersistedRuntimeConfig → JSON 序列化 → persist 写入固定路径。
 *
 * @param config 明文配置（含 apiKey）
 * @param passphrase 用户口令（不存储，仅作 KDF 输入）
 * @param injects 可选注入（测试用）
 */
export async function saveEncryptedConfig(
  config: RuntimeLLMConfig,
  passphrase: string,
  injects?: {
    encrypt?: EncryptFn
    persistWrite?: PersistWriteFn
  },
): Promise<void> {
  const encrypt = injects?.encrypt ?? cryptoEncryptApiKey
  const persistWrite = injects?.persistWrite ?? defaultPersistWrite

  // 加密 apiKey（明文即用即抛，仅密文落盘）
  const encryptedApiKey = await encrypt(passphrase, config.apiKey)

  const persisted: PersistedRuntimeConfig = {
    version: RUNTIME_CONFIG_VERSION,
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    encryptedApiKey,
  }

  await persistWrite(JSON.stringify(persisted))
}

/**
 * 解锁配置（读盘 + 解密 apiKey → 会话内存持有）。
 *
 * @param passphrase 用户口令
 * @param injects 可选注入（测试用）
 * @returns 解锁后的明文配置（同时已存入会话内存）
 * @throws 口令错误/密文损坏/配置不存在时抛错（绝不返回伪造配置）
 */
export async function unlockConfig(
  passphrase: string,
  injects?: {
    decrypt?: DecryptFn
    persistRead?: PersistReadFn
  },
): Promise<RuntimeLLMConfig> {
  const decrypt = injects?.decrypt ?? cryptoDecryptApiKey
  const persistRead = injects?.persistRead ?? defaultPersistRead

  const raw = await persistRead()
  if (raw === null) {
    throw new RuntimeConfigError('未找到已保存的 LLM 配置（首次使用请先保存）')
  }

  let persisted: PersistedRuntimeConfig
  try {
    persisted = JSON.parse(raw) as PersistedRuntimeConfig
  } catch (e) {
    throw new RuntimeConfigError(
      `配置文件损坏（JSON 解析失败）: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // 解密 apiKey（口令错/密文损坏时 Rust 返回 Crypto 错误）
  let apiKey: string
  try {
    apiKey = await decrypt(passphrase, persisted.encryptedApiKey)
  } catch (e) {
    throw new RuntimeConfigError(
      `解锁失败（口令错误或密文损坏）: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

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
 * 不删除磁盘文件（仅清内存）。
 */
export function clearSession(): void {
  session.clear()
}

/**
 * 获取当前会话配置（未解锁返回 null）。
 * 用于 Agent 编排时取 apiKey 发起 LLM 请求。
 */
export function getSessionConfig(): RuntimeLLMConfig | null {
  return session.get()
}

/** 是否已解锁 */
export function isSessionUnlocked(): boolean {
  return session.isUnlocked
}

// =============================================================================
// typed error
// =============================================================================

/** 运行时配置错误（解锁失败/配置损坏/未找到） */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeConfigError'
  }
}

// 便于测试：导出私有注入点（不破坏封装，仅测试模块用）
export const __testDefaults = {
  defaultPersistWrite,
  defaultPersistRead,
  RUNTIME_CONFIG_SAVE_ID,
  RUNTIME_CONFIG_VERSION,
}

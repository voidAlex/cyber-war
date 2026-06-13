/**
 * 战役包 ZIP 打包/解包 + JSON Schema 校验（campaign-zip.ts）。
 *
 * 实现 M4-A 验收#5（ZIP 导入导出闭环）：
 * - buildCampaignZip(payload)：把七文件序列化为 JSON，用 fflate 打包成 ZIP（Uint8Array）。
 * - loadCampaignZip(zipData)：解包 + ajv 校验七文件 schema；**校验失败 throw，不加载损坏包**。
 * - validateCampaignPayload(payload)：纯函数 ajv 校验入口（生成器/导入共用）。
 * - exportSaveAsZip / importSaveZip / importCampaignZip：经 gateway 调 Rust fs_*（Rust 侧防 zip-slip）。
 *
 * 安全（对应审计教训「ZIP 解包防 zip-slip」）：
 * - 前端 loadCampaignZip 仅在内存解包七文件 JSON 并校验，不写任意路径。
 * - 落盘到 saves/<saveId>/campaign/ 一律经 Rust fs_unpack_campaign（防 zip-slip）。
 * - schema 校验失败 throw，绝不加载损坏/恶意包。
 *
 * 本模块的 ZIP 内存打包/解包用 fflate；Tauri 落盘经 @gateway/tauri-bridge（铁律：
 * gateway 唯一 import @tauri-apps/api）。
 *
 * @module layers/persistence/campaign-zip
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import type { CampaignPayload } from '@/types'
import { CAMPAIGN_ZIP_FILES } from '@/types'

// JSON Schema（draft-07，resolveJsonModule 直接 import）
import manifestSchema from '@/campaign-schemas/manifest.schema.json'
import mapSchema from '@/campaign-schemas/map.schema.json'
import factionsSchema from '@/campaign-schemas/factions.schema.json'
import unitsSchema from '@/campaign-schemas/units.schema.json'
import commandersSchema from '@/campaign-schemas/commanders.schema.json'
import rulesSchema from '@/campaign-schemas/rules.schema.json'
import victorySchema from '@/campaign-schemas/victory.schema.json'

import {
  fsUnpackCampaign,
  fsExportSave,
  fsImportSave,
} from '@/layers/gateway/tauri-bridge'

// =============================================================================
// 类型契约
// =============================================================================

/** 战役包 schema 校验失败的 typed error（含字段级 ajv errors 详情） */
export class CampaignSchemaError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly errors: Array<Record<string, unknown>> | null,
  ) {
    super(message)
    this.name = 'CampaignSchemaError'
  }
}

/** ZIP 解包失败（非 ZIP / 损坏 / 缺文件）的 typed error */
export class CampaignZipError extends Error {
  constructor(
    message: string,
    readonly missingFiles?: string[],
  ) {
    super(message)
    this.name = 'CampaignZipError'
  }
}

// =============================================================================
// ajv 校验器（单例，七 schema 编译缓存）
// =============================================================================

/**
 * 创建并配置 ajv 实例（allErrors + strict + formats）。
 * 复用 agents/protocol/schema.ts 的配置策略，保证行为一致。
 */
export function createCampaignAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true })
  addFormats(ajv)
  return ajv
}

/** 单例 ajv（懒加载，避免模块 import 阶段构造） */
let _ajv: Ajv | null = null
function defaultAjv(): Ajv {
  if (!_ajv) _ajv = createCampaignAjv()
  return _ajv
}

/** 七文件 schema 映射表（文件名 → JSON Schema 对象） */
export const CAMPAIGN_SCHEMAS = {
  [CAMPAIGN_ZIP_FILES.manifest]: manifestSchema,
  [CAMPAIGN_ZIP_FILES.map]: mapSchema,
  [CAMPAIGN_ZIP_FILES.factions]: factionsSchema,
  [CAMPAIGN_ZIP_FILES.units]: unitsSchema,
  [CAMPAIGN_ZIP_FILES.commanders]: commandersSchema,
  [CAMPAIGN_ZIP_FILES.rules]: rulesSchema,
  [CAMPAIGN_ZIP_FILES.victory]: victorySchema,
} as const

/** 已编译校验器缓存（文件名 → ValidateFunction） */
const _validatorCache = new Map<string, ValidateFunction>()

/**
 * 取某文件的已编译 ajv 校验器（编译缓存）。
 *
 * @param fileName 七文件之一（CAMPAIGN_ZIP_FILES 值）
 * @param ajv 可选自定义 ajv 实例（测试注入用）
 */
export function getCampaignValidator(
  fileName: string,
  ajv?: Ajv,
): ValidateFunction {
  const cached = _validatorCache.get(fileName)
  if (cached) return cached
  const schema = CAMPAIGN_SCHEMAS[fileName as keyof typeof CAMPAIGN_SCHEMAS]
  if (!schema) {
    throw new Error(`未知战役包文件 schema: ${fileName}`)
  }
  const instance = ajv ?? defaultAjv()
  const compiled = instance.compile(schema) as ValidateFunction
  _validatorCache.set(fileName, compiled)
  return compiled
}

// =============================================================================
// validateCampaignPayload：纯函数 ajv 校验入口
// =============================================================================

/**
 * 校验战役包七文件 payload 是否全部通过 schema（纯函数，不调 IO）。
 *
 * 生成器产物 / 导入包加载前统一经此校验；失败 throw CampaignSchemaError。
 * 不在此处做跨文件引用一致性校验（如 commanderId 是否存在）——保持 schema 层职责单一，
 * 跨文件一致性由 world-state 构造层负责。
 *
 * @param payload 七文件聚合对象
 * @param ajv 可选自定义 ajv 实例（测试注入用）
 * @throws CampaignSchemaError 任一文件校验失败（含字段级 errors）
 */
export function validateCampaignPayload(
  payload: CampaignPayload,
  ajv?: Ajv,
): void {
  const files: Array<{ fileName: string; data: unknown }> = [
    { fileName: CAMPAIGN_ZIP_FILES.manifest, data: payload.manifest },
    { fileName: CAMPAIGN_ZIP_FILES.map, data: payload.map },
    { fileName: CAMPAIGN_ZIP_FILES.factions, data: payload.factions },
    { fileName: CAMPAIGN_ZIP_FILES.units, data: payload.units },
    { fileName: CAMPAIGN_ZIP_FILES.commanders, data: payload.commanders },
    { fileName: CAMPAIGN_ZIP_FILES.rules, data: payload.rules },
    { fileName: CAMPAIGN_ZIP_FILES.victory, data: payload.victory },
  ]

  for (const { fileName, data } of files) {
    const validate = getCampaignValidator(fileName, ajv)
    if (!validate(data)) {
      throw new CampaignSchemaError(
        `战役包文件 ${fileName} 未通过 schema 校验`,
        fileName,
        (validate.errors ?? null) as Array<Record<string, unknown>> | null,
      )
    }
  }
}

// =============================================================================
// buildCampaignZip：payload → ZIP（Uint8Array）
// =============================================================================

/**
 * 把战役包 payload 打包成 ZIP（fflate，返回 Uint8Array）。
 *
 * ZIP 内含七文件 JSON（顶层平铺，文件名见 CAMPAIGN_ZIP_FILES），
 * 与 doc/tech-design-v1.0.md §3.9 战役包结构对齐。
 *
 * 注意：本函数**不**校验 payload（调用方应先 validateCampaignPayload）。
 * 仅做序列化打包，便于生成器/导出复用。
 *
 * @param payload 七文件聚合
 * @returns ZIP 字节
 */
export function buildCampaignZip(payload: CampaignPayload): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [CAMPAIGN_ZIP_FILES.manifest]: strToU8(JSON.stringify(payload.manifest)),
    [CAMPAIGN_ZIP_FILES.map]: strToU8(JSON.stringify(payload.map)),
    [CAMPAIGN_ZIP_FILES.factions]: strToU8(JSON.stringify(payload.factions)),
    [CAMPAIGN_ZIP_FILES.units]: strToU8(JSON.stringify(payload.units)),
    [CAMPAIGN_ZIP_FILES.commanders]: strToU8(JSON.stringify(payload.commanders)),
    [CAMPAIGN_ZIP_FILES.rules]: strToU8(JSON.stringify(payload.rules)),
    [CAMPAIGN_ZIP_FILES.victory]: strToU8(JSON.stringify(payload.victory)),
  }
  return zipSync(files, { level: 6 })
}

// =============================================================================
// loadCampaignZip：ZIP → payload（解包 + ajv 校验）
// =============================================================================

/**
 * 解包战役包 ZIP 字节并校验七文件 schema。
 *
 * 流程：fflate 内存解包 → 读七文件 JSON → 逐文件 ajv 校验 → 返回 payload。
 * **校验失败 throw（CampaignSchemaError / CampaignZipError），绝不加载损坏/恶意包。**
 *
 * 安全：仅在内存解包读取 JSON，不写任意路径；落盘经 Rust fs_unpack_campaign（防 zip-slip）。
 *
 * @param zipData ZIP 字节
 * @returns 校验通过的七文件 payload
 * @throws CampaignZipError ZIP 损坏或缺文件
 * @throws CampaignSchemaError 任一文件 schema 校验失败
 */
export function loadCampaignZip(zipData: Uint8Array): CampaignPayload {
  // 1. 内存解包（fflate，不落盘）
  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(zipData)
  } catch (e) {
    throw new CampaignZipError(
      `ZIP 解包失败（非合法 ZIP 或已损坏）: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // 2. 读取并解析七文件（缺文件即拒绝）
  const readJson = (fileName: string): unknown => {
    const raw = unzipped[fileName]
    if (!raw) {
      throw new CampaignZipError(
        `战役包缺少必需文件: ${fileName}`,
        [fileName],
      )
    }
    try {
      return JSON.parse(strFromU8(raw))
    } catch (e) {
      throw new CampaignSchemaError(
        `文件 ${fileName} JSON.parse 失败: ${e instanceof Error ? e.message : String(e)}`,
        fileName,
        null,
      )
    }
  }

  const manifest = readJson(CAMPAIGN_ZIP_FILES.manifest)
  const map = readJson(CAMPAIGN_ZIP_FILES.map)
  const factions = readJson(CAMPAIGN_ZIP_FILES.factions)
  const units = readJson(CAMPAIGN_ZIP_FILES.units)
  const commanders = readJson(CAMPAIGN_ZIP_FILES.commanders)
  const rules = readJson(CAMPAIGN_ZIP_FILES.rules)
  const victory = readJson(CAMPAIGN_ZIP_FILES.victory)

  // 3. 校验七文件 schema（失败 throw）
  const validateFile = (fileName: string, data: unknown): void => {
    const validate = getCampaignValidator(fileName)
    if (!validate(data)) {
      throw new CampaignSchemaError(
        `战役包文件 ${fileName} 未通过 schema 校验`,
        fileName,
        (validate.errors ?? null) as Array<Record<string, unknown>> | null,
      )
    }
  }
  validateFile(CAMPAIGN_ZIP_FILES.manifest, manifest)
  validateFile(CAMPAIGN_ZIP_FILES.map, map)
  validateFile(CAMPAIGN_ZIP_FILES.factions, factions)
  validateFile(CAMPAIGN_ZIP_FILES.units, units)
  validateFile(CAMPAIGN_ZIP_FILES.commanders, commanders)
  validateFile(CAMPAIGN_ZIP_FILES.rules, rules)
  validateFile(CAMPAIGN_ZIP_FILES.victory, victory)

  return {
    manifest: manifest as CampaignPayload['manifest'],
    map: map as CampaignPayload['map'],
    factions: factions as CampaignPayload['factions'],
    units: units as CampaignPayload['units'],
    commanders: commanders as CampaignPayload['commanders'],
    rules: rules as CampaignPayload['rules'],
    victory: victory as CampaignPayload['victory'],
  }
}

// =============================================================================
// 存档 ZIP 导入导出（经 gateway 调 Rust fs_*，防 zip-slip）
// =============================================================================

/**
 * 导出当前存档为 ZIP（把 saves/<saveId> 整个打包到 outZipPath）。
 *
 * 经 Rust fs_export_save 落盘（Rust 侧无业务逻辑，仅打包文件树）。
 *
 * @param saveId 存档 id
 * @param outZipPath 输出 ZIP 路径（绝对路径，由 Tauri 文件对话框提供）
 */
export async function exportSaveAsZip(
  saveId: string,
  outZipPath: string,
): Promise<void> {
  await fsExportSave(saveId, outZipPath)
}

/**
 * 导入存档 ZIP 到新 saveId（解包到 saves/<newSaveId>）。
 *
 * 经 Rust fs_import_save 落盘（Rust 侧防 zip-slip：每 entry 校验无 `..` 且
 * canonicalize 仍在 sandbox 内）。
 *
 * @param newSaveId 新存档 id
 * @param zipPath ZIP 路径（绝对路径，由 Tauri 文件对话框提供）
 */
export async function importSaveZip(
  newSaveId: string,
  zipPath: string,
): Promise<void> {
  await fsImportSave(newSaveId, zipPath)
}

/**
 * 导入战役包 ZIP 到存档的 campaign 子目录（防 zip-slip）。
 *
 * 经 Rust fs_unpack_campaign 解包到 saves/<saveId>/campaign/。
 * 注意：此函数仅解包落盘；前端应在调用前用 loadCampaignZip 校验 ZIP 内容，
 * 或由 world-state 构造层读取 campaign/ 目录时再校验。
 *
 * @param saveId 存档 id
 * @param zipPath 战役包 ZIP 路径
 */
export async function importCampaignZip(
  saveId: string,
  zipPath: string,
): Promise<void> {
  await fsUnpackCampaign(saveId, zipPath)
}

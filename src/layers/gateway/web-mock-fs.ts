/**
 * Web mock 文件系统（web-mock-fs.ts）— 浏览器降级版 fs 层。
 *
 * 在 `isWebMode()` 为 true（浏览器 vite dev，供 agent-browser 验证）时，
 * 用 **内存 Map + localStorage 持久化** 模拟 Rust fs_* 全部 14 个命令，
 * 让应用在浏览器下能跑完整流程（创建存档、推进回合、刷新恢复不丢档）。
 *
 * 与 Rust 等价性：
 * - read/write world-state、snapshot、manifest、faction：直接覆盖（原子写语义在
 *   内存模型中等价于覆盖；localStorage 整体 serialize 落盘，刷新后恢复）。
 * - append event / diagnostics：真追加（`push` 到数组末尾，O(1)）。
 * - list saves：返回 Map 的 key（已含 manifest 的目录才返回）。
 * - read event-log 分页：按 offset/limit 切片。
 * - unpack/export/import campaign：web 模式无法真解 ZIP，简化为内存占位返回成功
 *   （标 TODO；agent-browser 验证主流程不强依赖）。
 * - llmConfigRead/Write：去口令后 LLM 非密钥字段明文 config（与 Rust `llm_config_*`
 *   对齐，独立 localStorage key，不再借用伪 saveId）。
 *
 * **localStorage 持久化**：key 前缀 `cwmock:`，每次写操作后整体 serialize 落盘，
 * 浏览器刷新后从 localStorage 反序列化恢复（验证"重启恢复"用）。
 *
 * **不 import `@tauri-apps/api`**（保持 gateway 边界）。
 *
 * @module layers/gateway/web-mock-fs
 */

// =============================================================================
// 类型契约：对齐 tauri-bridge 的 fs_* 函数签名（返回 Promise）
// =============================================================================

/** 单个存档在内存中的目录形态（对齐 saves/<saveId>/ 子结构） */
interface MockSaveDir {
  /** world-state.json 内容（原始 JSON 字符串；未初始化为 undefined） */
  worldState?: string
  /** snapshot.json 内容（原始 JSON 字符串） */
  snapshot?: string
  /** manifest.json 内容（原始 JSON 字符串；init 时写入，list 据此判定目录存在） */
  manifest?: string
  /** event-log.jsonl 行数组（append 真追加） */
  eventLog: string[]
  /** diagnostics.log 行数组（append 真追加；只写类别不写密钥） */
  diagnostics: string[]
  /** factions/<factionId>.json 内容映射 */
  factionFiles: Record<string, string>
  /** campaign/ 解包占位（web 模式不真解，仅标记存在） */
  campaignUnpacked?: boolean
}

/** localStorage 根 key（整体 serialize 落盘于此单 key） */
const LS_KEY = 'cwmock:saves'

/** 内存模型：saveId → 存档目录。模块级单例（整个应用生命周期共享） */
const saves = new Map<string, MockSaveDir>()

// =============================================================================
// localStorage 持久化（启动时加载，每次写后整体落盘）
// =============================================================================

/** 序列化整个 saves Map 到 localStorage（覆盖写）。失败静默（如 quota 超限）。 */
function persist(): void {
  try {
    // Map → 普通对象 → JSON（Map 不可直接 JSON.stringify）
    const obj: Record<string, MockSaveDir> = {}
    for (const [k, v] of saves) obj[k] = v
    localStorage.setItem(LS_KEY, JSON.stringify(obj))
  } catch {
    // quota 超限或隐私模式禁用 localStorage：静默降级为纯内存（刷新会丢档，
    // 但不影响当前会话流程，agent-browser 仍可验证）
  }
}

/** 启动时从 localStorage 加载（仅浏览器环境调用；首次为空则空 Map） */
function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const obj = JSON.parse(raw) as Record<string, MockSaveDir>
    for (const [k, v] of Object.entries(obj)) {
      // 兜底：旧数据可能缺字段，补全默认值
      saves.set(k, {
        worldState: v.worldState,
        snapshot: v.snapshot,
        manifest: v.manifest,
        eventLog: v.eventLog ?? [],
        diagnostics: v.diagnostics ?? [],
        factionFiles: v.factionFiles ?? {},
        campaignUnpacked: v.campaignUnpacked,
      })
    }
  } catch {
    // 损坏数据：忽略，从空开始
  }
}

// 仅在浏览器 web 模式下加载（模块首次 import 时执行一次）
// 注意：jsdom 也有 localStorage，但本文件只在 isWebMode() 为 true 时被调用，
// 故 lazy 加载更安全——见下方 ensureLoaded。
let loaded = false
/** 懒加载：首次访问前从 localStorage 恢复（避免模块 import 即读 localStorage）。 */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  if (typeof localStorage !== 'undefined') loadFromStorage()
}

// =============================================================================
// 内部工具
// =============================================================================

/** 取或创建存档目录（确保 eventLog 等数组字段初始化） */
function getOrCreate(saveId: string): MockSaveDir {
  ensureLoaded()
  let dir = saves.get(saveId)
  if (!dir) {
    dir = { eventLog: [], diagnostics: [], factionFiles: {} }
    saves.set(saveId, dir)
  }
  return dir
}

/** 取存档目录（不存在返回 null） */
function getOrNull(saveId: string): MockSaveDir | null {
  ensureLoaded()
  return saves.get(saveId) ?? null
}

// =============================================================================
// fs_* 等价函数（签名/语义对齐 Rust commands.rs）
// =============================================================================

/**
 * 读取 world-state.json 全文（原始 JSON 字符串）。
 * @throws 存档不存在（对齐 Rust：文件不存在 → fs error）
 */
export async function fsReadWorldState(saveId: string): Promise<string> {
  const dir = getOrNull(saveId)
  if (!dir || dir.worldState === undefined) {
    throw {
      type: 'fs' as const,
      message: `web-mock: world-state 不存在: ${saveId}`,
    }
  }
  return dir.worldState
}

/** 原子写入 world-state.json（直接覆盖；写后落盘）。 */
export async function fsWriteWorldState(saveId: string, content: string): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.worldState = content
  persist()
}

/** 原子写入 snapshot.json（直接覆盖；写后落盘）。 */
export async function fsWriteSnapshot(saveId: string, content: string): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.snapshot = content
  persist()
}

/**
 * 读取 snapshot.json 全文。
 * @throws 存档不存在或无 snapshot（对齐 Rust：不存在 → reject）
 */
export async function fsReadSnapshot(saveId: string): Promise<string> {
  const dir = getOrNull(saveId)
  if (!dir || dir.snapshot === undefined) {
    throw {
      type: 'fs' as const,
      message: `web-mock: snapshot 不存在: ${saveId}`,
    }
  }
  return dir.snapshot
}

/** 真追加一行事件到 event-log.jsonl（push，O(1)；写后落盘）。 */
export async function fsAppendEvent(saveId: string, line: string): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.eventLog.push(line)
  persist()
}

/**
 * 读取 event-log.jsonl 指定 offset/limit 范围的行（分页）。
 * offset 超出末尾返回空数组（对齐 Rust 的安全分页语义）。
 */
export async function fsReadEventLog(
  saveId: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const dir = getOrNull(saveId)
  if (!dir) return []
  return dir.eventLog.slice(offset, offset + limit)
}

/** 原子写入阵营文件 factions/<factionId>.json（覆盖；写后落盘）。 */
export async function fsWriteFactionFile(
  saveId: string,
  factionId: string,
  content: string,
): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.factionFiles[factionId] = content
  persist()
}

/** 真追加一行到 diagnostics.log（push；写后落盘）。 */
export async function fsAppendDiagnostics(saveId: string, line: string): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.diagnostics.push(line)
  persist()
}

/**
 * 真追加一行到全局应用日志 app.log（跨存档；mock：localStorage 数组）。
 *
 * 对齐 Rust `fs_append_app_log`：写 `<app_data_dir>/logs/app.log`。
 * web 模式用 localStorage key `cwmock:app-log` 存行数组（agent-browser
 * 可读 localStorage 验证 app.log 写入），push 真追加 O(1)。
 */
export async function fsAppendAppLog(line: string): Promise<void> {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(APP_LOG_LS_KEY)
    const arr: string[] = raw ? (JSON.parse(raw) as string[]) : []
    arr.push(line)
    localStorage.setItem(APP_LOG_LS_KEY, JSON.stringify(arr))
  } catch {
    // quota / 隐私模式：静默降级为忽略（best-effort 日志）
  }
}

/** 原子写入 manifest.json（覆盖；写后落盘）。 */
export async function fsWriteManifest(saveId: string, content: string): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.manifest = content
  persist()
}

/**
 * 列出所有存档的 saveId。
 * 对齐 Rust：扫描含 manifest.json 的目录。
 * （去口令后 runtime-config 不再用伪 saveId，但 `isPlayerSaveId` 兜底过滤保留
 * 以兼容可能残留的旧版目录。）
 */
export async function fsListSaves(): Promise<string[]> {
  ensureLoaded()
  const result: string[] = []
  for (const [id, dir] of saves) {
    if (dir.manifest !== undefined) result.push(id)
  }
  return result
}

/** 初始化存档目录（创建标准子目录 + 写 manifest）。 */
export async function fsInitSave(saveId: string, manifest: string): Promise<void> {
  const dir = getOrCreate(saveId)
  dir.manifest = manifest
  persist()
}

/** 删除存档目录（从 Map 移除；写后落盘）。 */
export async function fsDeleteSave(saveId: string): Promise<void> {
  ensureLoaded()
  saves.delete(saveId)
  persist()
}

// =============================================================================
// campaign 包相关（web 模式简化为内存占位）
// =============================================================================

/**
 * 解包战役包 ZIP 到 campaign/（web 模式占位）。
 *
 * 浏览器无法直接读本地 ZIP 路径（无文件系统访问）；agent-browser 验证主流程
 * 不强依赖解包，故简化为标记成功。
 * TODO：若需在浏览器真解 ZIP，可改走 File API + fflate 在内存解。
 */
export async function fsUnpackCampaign(_saveId: string, _zipPath: string): Promise<void> {
  const dir = getOrCreate(_saveId)
  dir.campaignUnpacked = true
  persist()
}

/**
 * 导出存档为 ZIP（web 模式占位）。
 * 浏览器无文件系统写出权限；标记成功，实际不出文件。
 */
export async function fsExportSave(_saveId: string, _outZipPath: string): Promise<void> {
  // 占位：不真打包。agent-browser 验证不依赖导出物。
}

/**
 * 导入存档 ZIP（web 模式占位）。
 * 浏览器无文件系统读权限；标记成功。
 */
export async function fsImportSave(_newSaveId: string, _zipPath: string): Promise<void> {
  // 占位：不真解包。
}

// =============================================================================
// llm config 命令（去口令改造后，非密钥字段明文 config，独立 localStorage key）
// =============================================================================

/** localStorage key（LLM 非密钥字段明文 config JSON） */
const LLM_CONFIG_LS_KEY = 'cwmock:llm-config'

/** localStorage key（全局应用日志 app.log 行数组，agent-browser 验证用） */
const APP_LOG_LS_KEY = 'cwmock:app-log'

/**
 * 读 LLM 配置文件（mock：localStorage `cwmock:llm-config`）。
 *
 * 对齐 Rust `llm_config_read`：返回原始 JSON 字符串；不存在返回 null。
 */
export async function llmConfigRead(): Promise<string | null> {
  if (typeof localStorage === 'undefined') return null
  try {
    const v = localStorage.getItem(LLM_CONFIG_LS_KEY)
    return v
  } catch {
    return null
  }
}

/**
 * 原子写 LLM 配置文件（mock：localStorage 覆盖写）。
 *
 * 对齐 Rust `llm_config_write`：接收序列化好的 JSON 字符串。
 */
export async function llmConfigWrite(content: string): Promise<void> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LLM_CONFIG_LS_KEY, content)
    } catch {
      // quota / 隐私模式：静默降级为纯内存
    }
  }
}

// =============================================================================
// 测试/调试辅助（仅 web-mock 内部与测试用，不导出给 tauri-bridge）
// =============================================================================

/** 清空内存 + localStorage（调试/测试重置用） */
export function __webMockFsReset(): void {
  saves.clear()
  loaded = true
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LS_KEY)
      localStorage.removeItem(LLM_CONFIG_LS_KEY)
      localStorage.removeItem(APP_LOG_LS_KEY)
    } catch {
      // ignore
    }
  }
}

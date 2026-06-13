/**
 * OPFS 存储层
 * 
 * 提供对 Origin Private File System 的访问，包括：
 * - 目录初始化和管理
 * - 原子写入（临时文件 + 重命名）
 * - 文件读写操作
 * 
 * 目录结构：
 * /saves/{saveId}/
 *   /world/
 *     world-state.json        # 唯一真相源
 *     turn-snapshot.json      # 回合快照
 *     event-log.jsonl         # 事件日志
 *   /factions/{factionId}/
 *     ledger-audit.md         # 审计日志
 *     context-summary.md      # 上下文摘要
 *   /system/
 *     diagnostics.log         # 诊断日志
 *   manifest.json
 * 
 * @module storage/opfs
 */


/** 存档根目录名称 */
const SAVES_DIR = 'saves'

/** 世界状态文件名 */
export const WORLD_STATE_FILE = 'world-state.json'

/** 回合快照文件名 */
export const TURN_SNAPSHOT_FILE = 'turn-snapshot.json'

/** 事件日志文件名 */
export const EVENT_LOG_FILE = 'event-log.jsonl'

/** 诊断日志文件名 */
export const DIAGNOSTICS_FILE = 'diagnostics.log'

/** 清单文件名 */
export const MANIFEST_FILE = 'manifest.json'

/**
 * OPFS 错误类型
 */
export class OPFSError extends Error {
  constructor(
    message: string,
    public readonly code: 'QUOTA_EXCEEDED' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED' | 'UNKNOWN',
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'OPFSError'
  }
}

/**
 * 获取 OPFS 根目录句柄
 * 
 * @returns OPFS 根目录句柄
 * @throws {OPFSError} 如果 OPFS 不可用
 */
export async function getOPFSRoot(): Promise<FileSystemDirectoryHandle> {
  try {
    const root = await navigator.storage.getDirectory()
    return root
  } catch (error) {
    throw new OPFSError(
      '无法访问 OPFS',
      'PERMISSION_DENIED',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/**
 * 初始化存档目录结构
 * 
 * @param saveId 存档 ID
 * @returns 存档目录句柄
 */
export async function initializeSaveDirectory(
  saveId: string
): Promise<FileSystemDirectoryHandle> {
  const root = await getOPFSRoot()
  
  // 创建 /saves/{saveId}/
  const savesDir = await root.getDirectoryHandle(SAVES_DIR, { create: true })
  const saveDir = await savesDir.getDirectoryHandle(saveId, { create: true })
  
  // 创建子目录
  await saveDir.getDirectoryHandle('world', { create: true })
  await saveDir.getDirectoryHandle('factions', { create: true })
  await saveDir.getDirectoryHandle('system', { create: true })
  
  return saveDir
}

/**
 * 获取存档目录句柄
 * 
 * @param saveId 存档 ID
 * @returns 存档目录句柄，如果不存在则返回 null
 */
export async function getSaveDirectory(
  saveId: string
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await getOPFSRoot()
    const savesDir = await root.getDirectoryHandle(SAVES_DIR, { create: false })
    return await savesDir.getDirectoryHandle(saveId, { create: false })
  } catch {
    return null
  }
}

/**
 * 列出所有存档
 * 
 * @returns 存档 ID 列表
 */
export async function listSaves(): Promise<string[]> {
  try {
    const root = await getOPFSRoot()
    const savesDir = await root.getDirectoryHandle(SAVES_DIR, { create: false })
    
    const saves: string[] = []
    // @ts-expect-error fix ignore - entries() 返回异步迭代器
    for await (const [name, handle] of savesDir.entries()) {
      if (handle.kind === 'directory') {
        saves.push(name)
      }
    }
    
    return saves
  } catch {
    return []
  }
}

/**
 * 原子写入文件
 * 
 * 使用"临时文件 + 重命名"模式确保原子性。
 * 
 * @param directory 目标目录
 * @param fileName 文件名
 * @param data 文件内容
 */
export async function atomicWriteFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  data: string | Blob
): Promise<void> {
  const tempName = `${fileName}.${Date.now()}.tmp`
  
  try {
    // 创建临时文件
    const tempHandle = await directory.getFileHandle(tempName, { create: true })
    const writable = await tempHandle.createWritable()
    
    // 写入数据
    await writable.write(data)
    await writable.close()
    
    // 尝试原子重命名（移动）
    // 注意：并非所有浏览器都支持 move()，降级到删除+重新创建
    try {
      // @ts-expect-error fix ignore - move() 是较新的 API
      if (typeof tempHandle.move === 'function') {
        // @ts-expect-error fix ignore
        await tempHandle.move(fileName)
      } else {
        // 降级方案：删除旧文件，重命名临时文件
        try {
          await directory.removeEntry(fileName)
        } catch {
          // 旧文件可能不存在，忽略错误
        }
        // 由于无法重命名，我们直接读取临时文件内容并写入目标文件
        const targetHandle = await directory.getFileHandle(fileName, { create: true })
        const targetWritable = await targetHandle.createWritable()
        const tempFile = await tempHandle.getFile()
        await targetWritable.write(await tempFile.arrayBuffer())
        await targetWritable.close()
        await directory.removeEntry(tempName)
      }
    } catch (moveError) {
      // 如果移动失败，尝试清理临时文件
      try {
        await directory.removeEntry(tempName)
      } catch {
        // 忽略清理错误
      }
      throw moveError
    }
  } catch (error) {
    if (error instanceof Error) {
      // 检查是否是配额错误
      if (error.name === 'QuotaExceededError' || error.message.includes('quota')) {
        throw new OPFSError(
          '存储空间不足',
          'QUOTA_EXCEEDED',
          error
        )
      }
    }
    throw new OPFSError(
      `写入文件失败: ${fileName}`,
      'UNKNOWN',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/**
 * 读取文件内容
 * 
 * @param directory 目标目录
 * @param fileName 文件名
 * @returns 文件内容，如果不存在则返回 null
 */
export async function readFile(
  directory: FileSystemDirectoryHandle,
  fileName: string
): Promise<string | null> {
  try {
    const fileHandle = await directory.getFileHandle(fileName, { create: false })
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

/**
 * 读取 JSON 文件
 * 
 * @param directory 目标目录
 * @param fileName 文件名
 * @returns 解析后的 JSON 对象，如果不存在或解析失败则返回 null
 */
export async function readJSONFile<T>(
  directory: FileSystemDirectoryHandle,
  fileName: string
): Promise<T | null> {
  const content = await readFile(directory, fileName)
  if (!content) return null
  
  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/**
 * 写入 JSON 文件（原子）
 * 
 * @param directory 目标目录
 * @param fileName 文件名
 * @param data 要写入的对象
 */
export async function writeJSONFile<T>(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  data: T
): Promise<void> {
  const json = JSON.stringify(data, null, 2)
  await atomicWriteFile(directory, fileName, json)
}

/**
 * 追加内容到日志文件
 * 
 * @param directory 目标目录
 * @param fileName 文件名
 * @param content 要追加的内容
 */
export async function appendToFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  content: string
): Promise<void> {
  try {
    // 读取现有内容
    const existing = await readFile(directory, fileName)
    const newContent = existing ? `${existing}${content}` : content
    
    // 原子写入
    await atomicWriteFile(directory, fileName, newContent)
  } catch (error) {
    throw new OPFSError(
      `追加文件失败: ${fileName}`,
      'UNKNOWN',
      error instanceof Error ? error : new Error(String(error))
    )
  }
}

/**
 * 删除文件
 * 
 * @param directory 目标目录
 * @param fileName 文件名
 */
export async function deleteFile(
  directory: FileSystemDirectoryHandle,
  fileName: string
): Promise<void> {
  try {
    await directory.removeEntry(fileName)
  } catch {
    // 文件可能不存在，忽略错误
  }
}

/**
 * 删除存档目录
 * 
 * @param saveId 存档 ID
 */
export async function deleteSave(saveId: string): Promise<void> {
  try {
    const root = await getOPFSRoot()
    const savesDir = await root.getDirectoryHandle(SAVES_DIR, { create: false })
    await savesDir.removeEntry(saveId, { recursive: true })
  } catch {
    // 存档可能不存在，忽略错误
  }
}

/**
 * 检查存储配额
 * 
 * @returns { quota: 总配额, usage: 已使用, available: 可用 }
 */
export async function checkStorageQuota(): Promise<{
  quota: number
  usage: number
  available: number
}> {
  const estimate = await navigator.storage.estimate()
  return {
    quota: estimate.quota ?? 0,
    usage: estimate.usage ?? 0,
    available: (estimate.quota ?? 0) - (estimate.usage ?? 0),
  }
}

/**
 * 生成唯一存档 ID
 * 
 * @returns 格式为 "save_{timestamp}_{random}" 的唯一 ID
 */
export function generateSaveId(): string {
  return `save_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * 生成场景种子
 * 
 * @returns 32 位随机字符串
 */
export function generateScenarioSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

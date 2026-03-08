/**
 * 游戏状态存储层
 * 
 * 提供对游戏状态的持久化操作，包括：
 * - world-state.json 的读写
 * - turn-snapshot.json 的读写
 * - event-log.jsonl 的追加
 * - diagnostics.log 的写入
 * 
 * @module storage/game-storage
 */

import type { GameState } from '@/types'
import {
  getSaveDirectory,
  initializeSaveDirectory,
  readJSONFile,
  writeJSONFile,
  appendToFile,
  deleteSave,
  generateSaveId,
  generateScenarioSeed,
  OPFSError,
} from './opfs'

/**
 * 清单文件接口
 */
export interface SaveManifest {
  /** 存档 ID */
  saveId: string
  
  /** 存档名称 */
  name: string
  
  /** 场景种子 */
  scenarioSeed: string
  
  /** 创建时间 */
  createdAt: string
  
  /** 最后更新时间 */
  updatedAt: string
  
  /** 当前回合 */
  currentTurn: number
  
  /** 当前阶段 */
  currentPhase: string
  
  /** 游戏版本 */
  version: string
}

/**
 * 回合快照接口
 */
export interface TurnSnapshot {
  /** 回合数 */
  turn: number
  
  /** 快照时间 */
  timestamp: string
  
  /** 快照时的完整游戏状态 */
  gameState: GameState
  
  /** 触发快照的阶段 */
  phase: string
}

/**
 * 事件日志条目接口
 */
export interface EventLogEntry {
  /** 事件 ID */
  id: string
  
  /** 事件时间戳 */
  timestamp: string
  
  /** 事件类型 */
  type: string
  
  /** 事件数据 */
  data: Record<string, unknown>
}

/**
 * 诊断日志级别
 */
export type DiagnosticLogLevel = 'error' | 'warn' | 'info' | 'debug'

/**
 * 诊断日志条目接口
 */
export interface DiagnosticLogEntry {
  /** 时间戳 */
  timestamp: string
  
  /** 日志级别 */
  level: DiagnosticLogLevel
  
  /** 日志消息 */
  message: string
  
  /** 附加数据 */
  data?: Record<string, unknown>
}

/**
 * 创建新游戏存档
 * 
 * @param name 存档名称
 * @param initialState 初始游戏状态（可选，使用默认值）
 * @returns 创建的游戏状态
 */
export async function createNewGame(
  name: string,
  initialState?: Partial<GameState>
): Promise<GameState> {
  const saveId = generateSaveId()
  const scenarioSeed = generateScenarioSeed()
  const now = new Date().toISOString()
  
  // 创建存档目录
  await initializeSaveDirectory(saveId)
  const saveDir = await getSaveDirectory(saveId)
  
  if (!saveDir) {
    throw new OPFSError('无法创建存档目录', 'UNKNOWN')
  }
  
  // 构建完整游戏状态
  const gameState: GameState = {
    turn: 1,
    phase: 'idle',
    worldState: {
      turnIndex: 0,
      factions: [],
      units: [],
      map: {
        width: 10,
        height: 10,
        cells: [],
      },
    },
    scenarioSeed,
    saveId,
    createdAt: now,
    updatedAt: now,
    version: '0.1.0',
    ...initialState,
  }
  
  // 保存 world-state.json
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  await writeJSONFile(worldDir, 'world-state.json', gameState)
  
  // 创建清单文件
  const manifest: SaveManifest = {
    saveId,
    name,
    scenarioSeed,
    createdAt: now,
    updatedAt: now,
    currentTurn: gameState.turn,
    currentPhase: gameState.phase,
    version: gameState.version,
  }
  await writeJSONFile(saveDir, 'manifest.json', manifest)
  
  // 初始化诊断日志
  const systemDir = await saveDir.getDirectoryHandle('system', { create: false })
  await logDiagnostic(systemDir, 'info', '游戏存档创建成功', { saveId, name })
  
  return gameState
}

/**
 * 加载游戏状态
 * 
 * @param saveId 存档 ID
 * @returns 游戏状态，如果不存在则返回 null
 */
export async function loadGame(saveId: string): Promise<GameState | null> {
  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) return null
  
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  const gameState = await readJSONFile<GameState>(worldDir, 'world-state.json')
  
  return gameState
}

/**
 * 保存游戏状态
 * 
 * @param gameState 游戏状态
 */
export async function saveGame(gameState: GameState): Promise<void> {
  const saveDir = await getSaveDirectory(gameState.saveId)
  if (!saveDir) {
    throw new OPFSError(`存档不存在: ${gameState.saveId}`, 'NOT_FOUND')
  }
  
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  
  // 更新时间戳
  const updatedState: GameState = {
    ...gameState,
    updatedAt: new Date().toISOString(),
  }
  
  // 原子写入 world-state.json
  await writeJSONFile(worldDir, 'world-state.json', updatedState)
  
  // 更新清单文件
  const manifest = await readJSONFile<SaveManifest>(saveDir, 'manifest.json')
  if (manifest) {
    manifest.updatedAt = updatedState.updatedAt
    manifest.currentTurn = updatedState.turn
    manifest.currentPhase = updatedState.phase
    await writeJSONFile(saveDir, 'manifest.json', manifest)
  }
}

/**
 * 创建回合快照
 * 
 * 在进入关键阶段前保存快照，用于错误恢复。
 * 
 * @param gameState 游戏状态
 * @param phase 触发快照的阶段
 */
export async function createTurnSnapshot(
  gameState: GameState,
  phase: string
): Promise<void> {
  const saveDir = await getSaveDirectory(gameState.saveId)
  if (!saveDir) return
  
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  
  const snapshot: TurnSnapshot = {
    turn: gameState.turn,
    timestamp: new Date().toISOString(),
    gameState,
    phase,
  }
  
  await writeJSONFile(worldDir, 'turn-snapshot.json', snapshot)
}

/**
 * 加载最近的回合快照
 * 
 * @param saveId 存档 ID
 * @returns 回合快照，如果不存在则返回 null
 */
export async function loadTurnSnapshot(saveId: string): Promise<TurnSnapshot | null> {
  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) return null
  
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  return await readJSONFile<TurnSnapshot>(worldDir, 'turn-snapshot.json')
}

/**
 * 追加事件到事件日志
 * 
 * @param saveId 存档 ID
 * @param entry 事件日志条目
 */
export async function appendEventLog(
  saveId: string,
  entry: EventLogEntry
): Promise<void> {
  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) return
  
  const worldDir = await saveDir.getDirectoryHandle('world', { create: false })
  const line = JSON.stringify(entry) + '\n'
  await appendToFile(worldDir, 'event-log.jsonl', line)
}

/**
 * 写入诊断日志
 * 
 * @param systemDir 系统目录句柄
 * @param level 日志级别
 * @param message 日志消息
 * @param data 附加数据
 */
export async function logDiagnostic(
  systemDir: FileSystemDirectoryHandle,
  level: DiagnosticLogLevel,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  }
  
  const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${
    data ? ` | ${JSON.stringify(data)}` : ''
  }\n`
  
  await appendToFile(systemDir, 'diagnostics.log', line)
}

/**
 * 写入诊断日志（通过存档 ID）
 * 
 * @param saveId 存档 ID
 * @param level 日志级别
 * @param message 日志消息
 * @param data 附加数据
 */
export async function logDiagnosticBySaveId(
  saveId: string,
  level: DiagnosticLogLevel,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) return
  
  const systemDir = await saveDir.getDirectoryHandle('system', { create: false })
  await logDiagnostic(systemDir, level, message, data)
}

/**
 * 获取存档清单
 * 
 * @param saveId 存档 ID
 * @returns 存档清单，如果不存在则返回 null
 */
export async function getSaveManifest(saveId: string): Promise<SaveManifest | null> {
  const saveDir = await getSaveDirectory(saveId)
  if (!saveDir) return null
  
  return await readJSONFile<SaveManifest>(saveDir, 'manifest.json')
}

/**
 * 删除存档
 * 
 * @param saveId 存档 ID
 */
export async function deleteGame(saveId: string): Promise<void> {
  await deleteSave(saveId)
}

/**
 * 生成唯一事件 ID
 */
export function generateEventId(): string {
  return `event_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

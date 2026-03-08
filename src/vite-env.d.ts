/// <reference types="vite/client" />

/// 游戏状态类型定义
interface GameState {
  turn: number
  phase: 'idle' | 'planning' | 'handshake' | 'locked' | 'resolution' | 'briefing' | 'persist'
  worldState: WorldState
}

interface WorldState {
  turnIndex: number
  scenarioSeed: string
  factions: Faction[]
  units: Unit[]
  map: GameMap
}

interface Faction {
  id: string
  name: string
  type: 'player' | 'enemy' | 'ally'
  trust: number // 0-100, for allies
}

interface Unit {
  id: string
  name: string
  factionId: string
  position: { x: number; y: number }
  hp: number
  maxHp: number
}

interface GameMap {
  width: number
  height: number
  cells: MapCell[][]
}

interface MapCell {
  x: number
  y: number
  terrain: 'plain' | 'mountain' | 'water' | 'urban' | 'forest'
  fogLevel: 0 | 1 | 2 | 3
}

/// Agent 类型定义
interface AgentAction {
  turn: number
  faction: string
  agentId: string
  intent: string
  payload: Record<string, unknown>
  confidence: number
  requiresConfirmation: boolean
}

/// OPFS 文件系统类型
interface FileSystemHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory'
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  }
}

export type {
  GameState,
  WorldState,
  Faction,
  Unit,
  GameMap,
  MapCell,
  AgentAction,
}

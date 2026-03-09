/**
 * 类型定义导出
 * 
 * 统一导出所有核心类型定义。
 * 
 * @module types
 */

// 核心状态类型
export type { 
  GamePhase, 
  GameState 
} from './game-state'
export { 
  GAME_VERSION, 
  DEFAULT_GAME_STATE 
} from './game-state'

// 世界状态类型
export type { WorldState } from './world-state'

// 阵营类型
export type { 
  FactionType, 
  Faction, 
  FactionResources 
} from './faction'

// 单位类型
export type { 
  Position, 
  UnitType, 
  UnitStatus, 
  Unit 
} from './unit'

// 地图类型
export type { 
  TerrainType, 
  FogLevel, 
  MapCell, 
  GameMap 
} from './map'
export { createEmptyMap } from './map'

// Agent 类型
export type {
  AgentIntent,
  AgentActionPayload,
  AgentAction,
  ActionEnvelope,
  EnvelopeKind,
  AgentProgressState,
  DirectorVerdictPayload,
  AgentRole,
  AgentStatus,
  AgentInfo
} from './agent-action'
export { generateActionId, generateEnvelopeId } from './agent-action'

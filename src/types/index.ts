/**
 * 权威类型契约 barrel（前后端共享）
 *
 * 所有游戏数据结构与状态机契约集中导出。
 * Rust 后端的 serde 类型与此处一一对应（commands.rs / crypto / llm）。
 *
 * 铁律：此目录为类型契约唯一真相源，禁止在此导入任何运行时副作用代码。
 *
 * @module types
 */

// === 顶层状态 ===
export type { GameState, GamePhase, StateMachineAction } from './game-state'
export { GAME_VERSION } from './game-state'
export type {
  WorldState,
  WorldIntelState,
  WorldDiplomacyState,
  DirectorMemory,
  ResolutionSummary,
} from './world-state'

// === 实体 ===
export type {
  Faction,
  FactionSide,
  CommanderProfile,
  CommanderTempo,
  FactionSupply,
} from './faction'
export type {
  Unit,
  UnitType,
  UnitStatusFlag,
  GridCoord,
  UnitIntelSnapshot,
} from './unit'
export type {
  GameMap,
  GridType,
  TerrainType,
  MapCell,
  HighValueNode,
} from './map'

// === 命令与 Agent ===
export type {
  ActionEnvelope,
  ActionState,
  AgentRole,
} from './action-envelope'
export type {
  AgentAction,
  AgentActionKind,
  EventLogSource,
  AgentContext,
  AgentMessage,
} from './agent-action'

// === 情报与外交 ===
export type {
  IntelLevel,
  IntelObservation,
  IntelDecayRule,
} from './intelligence'
export {
  INTEL_LEVEL_BLIND,
  INTEL_LEVEL_HEAT_PULSE,
  INTEL_LEVEL_FORMATION_CONFIRMED,
  INTEL_LEVEL_FULL_PENETRATION,
  DEFAULT_INTEL_DECAY_RULE,
} from './intelligence'
export type {
  DiplomacyTrust,
  DiplomaticStance,
  DiplomacyEvent,
} from './diplomacy'
export {
  INITIAL_TRUST_BY_STANCE,
  DEFAULT_DIPLOMACY_DELTAS,
} from './diplomacy'

// === 存档 ===
export type { SaveManifest, SaveListItem } from './save-manifest'

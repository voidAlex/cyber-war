/**
 * 游戏状态类型定义
 * 
 * 定义 WEGO 同步回合制游戏的核心状态结构。
 * 状态流转：idle -> planning -> handshake -> locked -> resolution -> briefing -> persist -> idle
 * 
 * @module types/game-state
 */

import type { WorldState } from './world-state'

/**
 * WEGO 回合阶段枚举
 * 
 * - idle: 空闲状态，等待开始新回合
 * - planning: 规划期，玩家观察沙盘、与参谋长对话、下达指令
 * - handshake: 握手期，参谋长反问、预演虚线、玩家确认
 * - locked: 锁定期，双方计划冻结，准备结算
 * - resolution: 结算期，导演部接管结算
 * - briefing: 战报期，战报分发、沙盘更新、情报半衰
 * - persist: 持久化期，JSON 状态落盘、快照
 */
export type GamePhase = 
  | 'idle' 
  | 'planning' 
  | 'handshake' 
  | 'locked' 
  | 'resolution' 
  | 'briefing' 
  | 'persist'

/**
 * 游戏状态接口
 * 
 * 这是游戏状态的顶层结构，包含当前回合、阶段和世界状态。
 * 此状态会持久化到 OPFS 的 world-state.json 中。
 */
export interface GameState {
  /** 当前回合数（从 1 开始） */
  turn: number
  
  /** 当前游戏阶段 */
  phase: GamePhase
  
  /** 世界状态（阵营、单位、地图等） */
  worldState: WorldState
  
  /** 场景种子（用于确定性随机） */
  scenarioSeed: string
  
  /** 存档 ID（用于 OPFS 目录） */
  saveId: string
  
  /** 创建时间（ISO 8601 格式） */
  createdAt: string
  
  /** 最后更新时间（ISO 8601 格式） */
  updatedAt: string
  
  /** 版本号（用于数据迁移） */
  version: string
}

/**
 * 当前游戏版本号
 * 遵循语义化版本规范
 */
export const GAME_VERSION = '0.1.0' as const

/**
 * 默认游戏状态
 * 用于初始化新游戏
 */
export const DEFAULT_GAME_STATE: Omit<GameState, 'saveId' | 'scenarioSeed' | 'createdAt' | 'updatedAt'> = {
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
  version: GAME_VERSION,
}

/**
 * 世界状态类型定义
 * 
 * 定义游戏世界的核心数据结构，包括阵营、单位、地图等。
 * 此状态是游戏数据的唯一真相源。
 * 
 * @module types/world-state
 */

import type { Faction } from './faction'
import type { Unit } from './unit'
import type { GameMap } from './map'

/**
 * 世界状态接口
 * 
 * 包含游戏世界的所有动态数据：
 * - 阵营信息（玩家、敌人、盟友）
 * - 单位信息（部队、装备）
 * - 地图信息（地形、迷雾）
 */
export interface WorldState {
  /** 回合索引（从 0 开始，与确定性随机种子配合使用） */
  turnIndex: number
  
  /** 阵营列表 */
  factions: Faction[]
  
  /** 单位列表 */
  units: Unit[]
  
  /** 地图数据 */
  map: GameMap
}

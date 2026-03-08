/**
 * 阵营类型定义
 * 
 * 定义游戏中的阵营/势力数据结构。
 * 
 * @module types/faction
 */

/**
 * 阵营类型枚举
 * 
 * - player: 玩家阵营（玩家控制）
 * - enemy: 敌方阵营（AI 控制）
 * - ally: 盟友阵营（AI 控制，但与玩家友好）
 */
export type FactionType = 'player' | 'enemy' | 'ally'

/**
 * 阵营接口
 * 
 * 代表游戏中的一个势力/阵营。
 */
export interface Faction {
  /** 阵营唯一标识符 */
  id: string
  
  /** 阵营名称 */
  name: string
  
  /** 阵营类型 */
  type: FactionType
  
  /** 
   * 信任度（0-100）
   * 仅对盟友阵营有效，表示盟友履行请求的概率
   */
  trust: number
  
  /** 阵营颜色（十六进制，如 #FF0000） */
  color: string
  
  /** 阵营描述 */
  description?: string
  
  /** 阵营资源 */
  resources?: FactionResources
}

/**
 * 阵营资源接口
 */
export interface FactionResources {
  /** 物资 */
  supplies: number
  
  /** 弹药 */
  ammunition: number
  
  /** 燃料 */
  fuel: number
  
  /** 情报点数 */
  intelligence: number
}

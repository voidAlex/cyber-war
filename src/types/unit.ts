/**
 * 单位类型定义
 * 
 * 定义游戏中的军事单位数据结构。
 * 
 * @module types/unit
 */

/**
 * 位置接口
 * 表示地图上的坐标（网格坐标）
 */
export interface Position {
  /** X 坐标（列索引，从 0 开始） */
  x: number
  
  /** Y 坐标（行索引，从 0 开始） */
  y: number
}

/**
 * 单位类型枚举
 */
export type UnitType = 
  | 'infantry'      // 步兵
  | 'armor'         // 装甲
  | 'artillery'     // 炮兵
  | 'recon'         // 侦察
  | 'support'       // 支援
  | 'hq'            // 指挥部

/**
 * 单位状态枚举
 */
export type UnitStatus = 
  | 'active'        // 活跃
  | 'damaged'       // 受损
  | 'destroyed'     // 摧毁
  | 'retreating'    // 撤退中
  | 'hidden'        // 隐蔽

/**
 * 单位接口
 * 
 * 代表游戏中的一个军事单位（部队、装备等）。
 */
export interface Unit {
  /** 单位唯一标识符 */
  id: string
  
  /** 单位名称/代号 */
  name: string
  
  /** 所属阵营 ID */
  factionId: string
  
  /** 单位类型 */
  type: UnitType
  
  /** 当前位置 */
  position: Position
  
  /** 当前生命值 */
  hp: number
  
  /** 最大生命值 */
  maxHp: number
  
  /** 单位状态 */
  status: UnitStatus
  
  /** 移动点数 */
  movementPoints: number
  
  /** 最大移动点数 */
  maxMovementPoints: number
  
  /** 攻击力 */
  attack: number
  
  /** 防御力 */
  defense: number
  
  /** 视野范围 */
  visionRange: number
  
  /** 射程 */
  range: number
  
  /** 是否已完成本回合行动 */
  hasActed: boolean
  
  /** 单位描述 */
  description?: string
}

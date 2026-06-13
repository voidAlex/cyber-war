/**
 * 地图类型定义
 *
 * 沙盘网格（方格/六边形），含地形、移动消耗、防御加成、目标节点。
 * 沙盘渲染由 PixiJS 消费这些数据。
 *
 * @module types/map
 */

/**
 * 网格类型。
 *
 * - square：方格网格（4 邻接）
 * - hex：六边形网格（6 邻接）
 */
export type GridType = 'square' | 'hex'

/**
 * 地形类型（影响移动消耗、防御加成、可见度）。
 */
export type TerrainType =
  | 'plain' // 平原
  | 'forest' // 森林
  | 'mountain' // 山地
  | 'water' // 水域（不可通行/渡河惩罚）
  | 'urban' // 城镇
  | 'fortress' // 要塞（极高防御加成）
  | 'marsh' // 沼泽（高移动消耗）

/**
 * 单个网格单元。
 */
export interface MapCell {
  /** 单元唯一标识 */
  id: string
  /** 列（x） */
  col: number
  /** 行（y） */
  row: number
  /** 地形 */
  terrain: TerrainType
  /** 移动消耗（点数，影响机动） */
  movementCost: number
  /** 防御加成（0..1 比例，影响战斗结算） */
  defenseBonus: number
  /** 是否为高价值目标节点（胜负条件相关） */
  isObjective: boolean
}

/**
 * 高价值节点（堡垒、城市、隘口等，胜负条件引用）。
 */
export interface HighValueNode {
  /** 节点唯一标识 */
  id: string
  /** 节点名称（如「杜奥蒙堡」） */
  name: string
  /** 所在单元 id */
  cellId: string
  /** 占领阈值（控制方需驻守的回合数等，domain 解释） */
  controlThreshold: number
}

/**
 * 游戏地图（WorldState.map）。
 *
 * cells 为一维数组（行优先），col/row 由 cell 自身字段决定，
 * 便于六边形网格与稀疏网格扩展。
 */
export interface GameMap {
  /** 网格类型 */
  gridType: GridType
  /** 列数 */
  cols: number
  /** 行数 */
  rows: number
  /** 所有单元（一维，行优先） */
  cells: MapCell[]
  /** 高价值节点列表 */
  highValueNodes: HighValueNode[]
}

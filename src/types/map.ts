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
  /**
   * 是否为补给来源（补给网络起点，第 4 批）。
   *
   * 通常是己方纵深城市/集结场（如凡尔登城、德军后方火车站）。
   * computeSupplyConnectivity 沿 supplyNetwork.lines 的路径从单位向 source
   * 做 BFS，敌方占据路径上任意 cellId 即视为阻断（connected=false）。
   * 不与 isObjective 互斥——既是补给源又是高价值节点完全可能（如凡尔登城）。
   */
  isSupplySource?: boolean
}

/**
 * 补给线类型（影响"切断难度"与叙事，第 4 批）。
 *
 * - road：公路（如凡尔登"神圣之路" Voie Sacrée）。
 * - rail：铁路（如德军后方战略铁路）。
 * - river：水运补给（如默兹河驳船航线）。
 */
export type SupplyLineType = 'road' | 'rail' | 'river'

/**
 * 补给线（一条有序 cellId 路径，从 source 到前线，第 4 批）。
 *
 * cellIds 是**有序序列**：cellIds[0] 为补给源（与 map.cell.isSupplySource 对应），
 * 后续依次向敌方前线延伸。computeSupplyConnectivity 沿此序列从单位位置向
 * 源头方向走（路径上任何 cell 被敌方单位占据即视为阻断）。
 *
 * 一条线属单一阵营（factionId），多阵营补给网络由 lines 数组表达。
 */
export interface SupplyLine {
  /** 线唯一标识 */
  id: string
  /** 所属阵营 id（仅该阵营单位受此线补给） */
  factionId: string
  /** 有序 cellId 路径：cellIds[0]=source（isSupplySource=true），末段为前线 */
  cellIds: string[]
  /** 线类别（影响切断难度与叙事） */
  type: SupplyLineType
}

/**
 * 补给网络（GameMap.supplyNetwork，第 4 批）。
 *
 * 一张地图可含多条 SupplyLine（每阵营若干条）。computeSupplyConnectivity
 * 仅消费此结构定义的路径，**绝不编造**未声明的补给路线（铁律）。
 */
export interface SupplyNetwork {
  /** 补给线列表（每条属某阵营） */
  lines: SupplyLine[]
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
  /**
   * 补给网络（第 4 批，可选）。
   *
   * 缺省（undefined）时所有单位恒为连通状态（向后兼容，存量地图/测试不受影响）。
   * 一旦声明，computeSupplyConnectivity 只用此结构定义的路径判连通性。
   */
  supplyNetwork?: SupplyNetwork
}

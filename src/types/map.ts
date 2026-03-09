/**
 * 地图类型定义
 * 
 * 定义游戏地图的数据结构，包括地形和迷雾系统。
 * 
 * @module types/map
 */

/**
 * 地形类型枚举
 * 
 * - plain: 平原（正常移动）
 * - mountain: 山地（移动消耗增加，提供防御加成）
 * - water: 水域（不可通行，除非有特殊能力）
 * - urban: 城镇（提供防御加成，可能有资源）
 * - forest: 森林（提供隐蔽，移动消耗略增）
 */
export type TerrainType = 'plain' | 'mountain' | 'water' | 'urban' | 'forest'

/**
 * 迷雾等级枚举
 * 
 * 情报系统使用 0-3 级迷雾：
 * - 0: 完全可见（己方控制或侦察范围内）
 * - 1: 部分可见（最近侦察，信息可能过时）
 * - 2: 模糊可见（情报残影，时间戳较旧）
 * - 3: 完全迷雾（无情报）
 */
export type FogLevel = 0 | 1 | 2 | 3

/**
 * 地图单元格接口
 * 
 * 代表地图上的一个格子。
 */
export interface MapCell {
  /** X 坐标（列索引） */
  x: number
  
  /** Y 坐标（行索引） */
  y: number
  
  /** 地形类型 */
  terrain: TerrainType
  
  /** 迷雾等级（针对当前玩家视角） */
  fogLevel: FogLevel
  
  /** 
   * 情报时间戳（Unix 时间戳）
   * 记录最后一次获得该格子情报的时间
   */
  intelligenceTimestamp?: number

  /** 残影单位 ID（用于迷雾残影展示） */
  ghostUnitId?: string

  /** 残影情报时间戳（Unix 时间戳） */
  ghostTimestamp?: number
  
  /** 该格子上的单位 ID（如果有） */
  unitId?: string
  
  /** 控制该格子的阵营 ID（如果有） */
  controllingFactionId?: string
  
  /** 地形特征（如桥梁、据点等） */
  features?: string[]
}

/**
 * 游戏地图接口
 * 
 * 代表完整的游戏地图。
 */
export interface GameMap {
  /** 地图宽度（列数） */
  width: number
  
  /** 地图高度（行数） */
  height: number
  
  /** 地图单元格（二维数组，[y][x] 访问） */
  cells: MapCell[][]
}

/**
 * 创建空白地图
 * 
 * @param width 宽度
 * @param height 高度
 * @param defaultTerrain 默认地形
 * @returns 空白地图
 */
export function createEmptyMap(
  width: number, 
  height: number, 
  defaultTerrain: TerrainType = 'plain'
): GameMap {
  const cells: MapCell[][] = []
  
  for (let y = 0; y < height; y++) {
    const row: MapCell[] = []
    for (let x = 0; x < width; x++) {
      row.push({
        x,
        y,
        terrain: defaultTerrain,
        fogLevel: 3, // 默认完全迷雾
      })
    }
    cells.push(row)
  }
  
  return {
    width,
    height,
    cells,
  }
}

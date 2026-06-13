/**
 * 凡尔登战役 1916 — map.json 数据。
 *
 * 史实地理（查证自维基/百科）：
 * - 默兹河（Meuse）两岸：西岸（左岸）、东岸（右岸）。德军主攻东岸。
 * - 高地与森林密布，要塞工事（杜奥蒙堡、沃堡、苏维尔堡）防御加成极高。
 * - 高价值节点：杜奥蒙堡 Fort Douaumont（2/25 陷落，10 月法军收复）、
 *   沃堡 Fort Vaux、苏维尔堡 Fort Souville、凡尔登城 Verdun。
 *
 * 网格设计：10×8 方格（cols=10, rows=8），默兹河纵贯中部（col=5 一列 water），
 * 东岸（col≥5）为德军主攻方向。要塞散布东岸高地。
 *
 * @module data/verdun-1916/map
 */

import type { CampaignMap } from '@/types'

/** 凡尔登地图网格规模 */
const COLS = 10
const ROWS = 8

/** 默兹河纵贯列（水） */
const MEUSE_COL = 5

/**
 * 构造凡尔登地图单元数组（行优先）。
 * 默兹河纵贯 col=5；东岸为山地+森林+要塞；西岸含凡尔登城。
 */
function buildVerdunCells(): CampaignMap['cells'] {
  const cells: CampaignMap['cells'] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const id = `cell-${col}-${row}`
      let terrain: CampaignMap['cells'][number]['terrain'] = 'plain'
      let movementCost = 1
      let defenseBonus = 0.1
      let isObjective = false

      if (col === MEUSE_COL) {
        // 默兹河：水域，高移动消耗（渡河惩罚），低防御
        terrain = 'water'
        movementCost = 4
        defenseBonus = 0
      } else if (col > MEUSE_COL) {
        // 东岸（德军主攻方向）：山地+森林+要塞高地
        if ((col === 7 && row === 2)) {
          // 杜奥蒙堡
          terrain = 'fortress'
          movementCost = 3
          defenseBonus = 0.85
          isObjective = true
        } else if (col === 8 && row === 3) {
          // 沃堡
          terrain = 'fortress'
          movementCost = 3
          defenseBonus = 0.8
          isObjective = true
        } else if (col === 7 && row === 4) {
          // 苏维尔堡
          terrain = 'fortress'
          movementCost = 3
          defenseBonus = 0.82
          isObjective = true
        } else if (row <= 1 || (col >= 8 && row <= 2)) {
          // 东岸北部高地：山地
          terrain = 'mountain'
          movementCost = 3
          defenseBonus = 0.35
        } else if (col >= 8) {
          // 东岸东部：森林
          terrain = 'forest'
          movementCost = 2
          defenseBonus = 0.25
        } else {
          // 东岸平原（战场焦土）
          terrain = 'plain'
          movementCost = 1
          defenseBonus = 0.1
        }
      } else {
        // 西岸：凡尔登城在 col=2,row=4
        if (col === 2 && row === 4) {
          // 凡尔登城
          terrain = 'urban'
          movementCost = 2
          defenseBonus = 0.5
          isObjective = true
        } else if (col <= 1) {
          // 西岸西部：森林（"神圣之路"后勤走廊）
          terrain = 'forest'
          movementCost = 2
          defenseBonus = 0.25
        } else {
          // 西岸平原
          terrain = 'plain'
          movementCost = 1
          defenseBonus = 0.1
        }
      }

      cells.push({ id, col, row, terrain, movementCost, defenseBonus, isObjective })
    }
  }
  return cells
}

/** 凡尔登地图 */
export const verdunMap: CampaignMap = {
  gridType: 'square',
  cols: COLS,
  rows: ROWS,
  cells: buildVerdunCells(),
  highValueNodes: [
    {
      id: 'fort-douaumont',
      name: '杜奥蒙堡 (Fort Douaumont)',
      // 史实：2/25 陷落于德军，10 月法军收复
      cellId: 'cell-7-2',
      controlThreshold: 2,
    },
    {
      id: 'fort-vaux',
      name: '沃堡 (Fort Vaux)',
      cellId: 'cell-8-3',
      controlThreshold: 2,
    },
    {
      id: 'fort-souville',
      name: '苏维尔堡 (Fort Souville)',
      cellId: 'cell-7-4',
      controlThreshold: 2,
    },
    {
      id: 'verdun-city',
      name: '凡尔登城 (Verdun)',
      cellId: 'cell-2-4',
      controlThreshold: 3,
    },
  ],
}

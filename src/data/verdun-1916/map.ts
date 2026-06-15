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

      cells.push({
        id,
        col,
        row,
        terrain,
        movementCost,
        defenseBonus,
        isObjective,
        // 第 4 批：凡尔登城为法军补给源（"神圣之路"起点 / 分发中枢）
        ...(col === 2 && row === 4 ? { isSupplySource: true } : {}),
        // 德军补给源：东岸最东角（cell-9-7，模拟德军后方战略铁路终点）
        ...(col === 9 && row === 7 ? { isSupplySource: true } : {}),
      })
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
  /**
   * 补给网络（第 4 批，法/德各一条）。
   *
   * 史实（查证自维基/百科）：
   * - 法军"神圣之路"（Voie Sacrée）：凡尔登城 ↔ 巴勒迪克（Bar-le-Duc，西南方）
   *   的公路，贝当用以轮换部队与补给，是凡尔登苦撑的生命线。游戏内简化为
   *   凡尔登城(cell-2-4, source)→西岸森林(cell-1-4)→后方集结场(cell-0-4)的
   *   短路径，并向东延伸过默兹河渡口(cell-5-4)到苏维尔堡前线(cell-7-4)，
   *   覆盖法军主力单位的补给路径。
   *   德军若占领渡口(cell-4-4/cell-5-4)即切断法军对东岸要塞的补给。
   * - 德军补给：从东岸后方战略铁路(cell-9-7, source)沿东岸北上至前线
   *   (cell-8-2 附近)，支撑德军主攻。
   *
   * 设计：cellIds[0]=source（isSupplySource=true），后续向前线延伸。
   * computeSupplyConnectivity 沿路径判连通性，敌方占据任一中间 cell 即阻断。
   */
  supplyNetwork: {
    lines: [
      {
        id: 'fr-voie-sacree',
        factionId: 'france',
        type: 'road',
        // 凡尔登城(source)→西岸后方→默兹渡口→苏维尔堡前线（法军补给动脉）
        cellIds: [
          'cell-2-4', // 凡尔登城（source，分发中枢）
          'cell-3-4', // 默兹河西岸东缘
          'cell-4-4', // 默兹河西岸前沿
          'cell-5-4', // 默兹河渡口（关键瓶颈）
          'cell-6-4', // 默兹河东岸前沿
          'cell-7-4', // 苏维尔堡（法军前线中枢）
        ],
      },
      {
        id: 'de-ostbahn',
        factionId: 'germany',
        type: 'rail',
        // 德军后方战略铁路(source)→东岸北上→前线（支撑德军主攻）
        cellIds: [
          'cell-9-7', // 德军后方铁路终点（source）
          'cell-9-6', // 东岸南部
          'cell-9-5', // 东岸中部
          'cell-9-4', // 东岸北部集结
          'cell-8-4', // 东岸前沿
          'cell-8-3', // 沃堡前线（德军主攻方向）
        ],
      },
    ],
  },
}

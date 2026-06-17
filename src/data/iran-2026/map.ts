/**
 * 美以伊冲突 2026 — map.json 数据。
 *
 * 地理设定（查证自维基/百科地理坐标，虚构近未来剧本）：
 * - 波斯湾：伊朗以南/阿拉伯半岛以北的狭长海域，美军航母战斗群活动区域。
 * - 霍尔木兹海峡：波斯湾出口（cell-8-11），全球石油运输咽喉；伊朗导弹快艇/岸基反舰导弹封锁要点。
 * - 纳坦兹核设施（cell-12-4）：伊朗铀浓缩核心设施，位于伊朗中部山地；美以打击首要目标。
 * - 福特罗核设施（cell-13-6）：伊朗深埋地下（山体内）的铀浓缩设施，极难摧毁；美以打击次要目标。
 * - 德黑兰（cell-14-3）：伊朗首都，伊朗政治/军事指挥中枢；伊朗补给源。
 * - 以色列（cell-1-5）：美以联军后方基地（以色列本土），F-35 出发地；美以补给源。
 *
 * 网格设计：16×12 方格（cols=16, rows=12，col 0-15，row 0-11）。
 * 地形分布：
 * - 波斯湾水域：西南海域（col 3-6,row 10-11 + col 7-8,row 11），含霍尔木兹海峡（cell-8-11）。
 * - 伊朗本土：东部（col 8-15），山地（扎格罗斯山脉，col 10-15,row 4-8）+ 平原（德黑兰周边）。
 * - 核设施（fortress terrain，深埋工事）：纳坦兹(cell-12-4)、福特罗(cell-13-6)，isObjective。
 * - 城市：德黑兰(cell-14-3)、以色列(cell-1-5)。
 *
 * @module data/iran-2026/map
 */

import type { CampaignMap } from '@/types'

/** 美以伊冲突地图网格规模 */
const COLS = 16
const ROWS = 12

/**
 * 构造美以伊冲突地图单元数组（行优先）。
 *
 * 地形规则（按 cell 坐标判定）：
 * - 波斯湾水域：row>=10 且 col>=3 且 col<=8（西南海域 + 霍尔木兹海峡）。
 * - 核设施（fortress）：纳坦兹/福特罗（深埋地下工事，防御加成极高）。
 * - 城市（urban）：德黑兰/以色列。
 * - 山地：扎格罗斯山脉（伊朗西部/中部，col 10-15,row 4-8）。
 * - 平原/森林：其余。
 */
function buildIranCells(): CampaignMap['cells'] {
  const cells: CampaignMap['cells'] = []
  // 核设施 cell（fortress 深埋工事）
  const nuclearCells = new Set<string>(['cell-12-4', 'cell-13-6'])
  // 城市 cell
  const urbanCells = new Set<string>(['cell-14-3', 'cell-1-5'])
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const id = `cell-${col}-${row}`
      let terrain: CampaignMap['cells'][number]['terrain'] = 'plain'
      let movementCost = 1
      let defenseBonus = 0.1
      let isObjective = false
      let isSupplySource = false

      // === 波斯湾水域（西南海域 + 霍尔木兹海峡） ===
      // row>=10 且 col 在 3-8 之间为波斯湾/海峡
      if (row >= 10 && col >= 3 && col <= 8) {
        terrain = 'water'
        movementCost = 2 // 海域（航母/快艇机动）
        defenseBonus = 0
      } else if (nuclearCells.has(id)) {
        // 核设施：深埋地下工事（fortress，防御加成极高，极难摧毁）
        terrain = 'fortress'
        movementCost = 4
        defenseBonus = 0.9
        isObjective = true
      } else if (urbanCells.has(id)) {
        // 城市：德黑兰/以色列
        terrain = 'urban'
        movementCost = 2
        defenseBonus = 0.6
        // 德黑兰/以色列为各自阵营补给源（在下方标记）
      } else if (col >= 10 && col <= 15 && row >= 4 && row <= 8) {
        // 扎格罗斯山脉（伊朗西部/中部山地，核设施天然屏障）
        terrain = 'mountain'
        movementCost = 3
        defenseBonus = 0.4
      } else if (col <= 2 && row >= 4 && row <= 7) {
        // 以色列周边（地中海东岸平原/丘陵）
        terrain = 'plain'
        movementCost = 1
        defenseBonus = 0.15
      } else {
        // 其余：中东平原/沙漠（plain 代理）
        terrain = 'plain'
        movementCost = 1
        defenseBonus = 0.1
      }

      // === 补给源标记 ===
      // 美以补给源：以色列本土（cell-1-5，F-35/特种部队基地 + 后勤枢纽）
      if (col === 1 && row === 5) {
        isSupplySource = true
      }
      // 伊朗补给源：德黑兰（cell-14-3，政治/军事指挥中枢 + 弹道导弹指挥）
      if (col === 14 && row === 3) {
        isSupplySource = true
      }

      cells.push({
        id,
        col,
        row,
        terrain,
        movementCost,
        defenseBonus,
        isObjective,
        ...(isSupplySource ? { isSupplySource } : {}),
      })
    }
  }
  return cells
}

/** 美以伊冲突地图 */
export const iranMap: CampaignMap = {
  gridType: 'square',
  cols: COLS,
  rows: ROWS,
  cells: buildIranCells(),
  highValueNodes: [
    {
      id: 'natanz',
      name: '纳坦兹核设施 (Natanz)',
      // 伊朗铀浓缩核心设施（中部山地），美以打击首要目标
      cellId: 'cell-12-4',
      controlThreshold: 2,
    },
    {
      id: 'fordow',
      name: '福特罗核设施 (Fordow)',
      // 深埋地下铀浓缩设施（山体内），极难摧毁，美以打击次要目标
      cellId: 'cell-13-6',
      controlThreshold: 2,
    },
    {
      id: 'tehran',
      name: '德黑兰 (Tehran)',
      // 伊朗首都/指挥中枢（伊朗补给源）
      cellId: 'cell-14-3',
      controlThreshold: 3,
    },
    {
      id: 'hormuz',
      name: '霍尔木兹海峡 (Strait of Hormuz)',
      // 全球石油运输咽喉（伊朗封锁要点；美军航母战斗群活动区）
      cellId: 'cell-8-11',
      controlThreshold: 2,
    },
  ],
  /**
   * 补给网络（第 4 批，美以/伊朗各一条）。
   *
   * 设定（查证自地理 + 近未来剧本）：
   * - 美以补给：波斯湾航母战斗群 ↔ 以色列本土（海上 + 空中补给走廊）。以色列为 F-35/特种部队
   *   出发基地；航母战斗群在波斯湾提供海空打击。
   * - 伊朗补给：德黑兰（指挥中枢）→ 各弹道导弹阵地/革命卫队据点（陆上公路网）。
   *
   * 设计：cellIds[0]=source（isSupplySource=true），后续向前线延伸。
   */
  supplyNetwork: {
    lines: [
      // === 美以补给：以色列本土 → 波斯湾航母（海上 + 空中走廊） ===
      {
        id: 'usisrael-israel-carrier-supply',
        factionId: 'usisrael',
        type: 'road', // 海上 + 空中补给走廊无完全对应类型，用 road 代理
        // 以色列(source)→地中海东岸→阿拉伯半岛北→波斯湾航母战斗群
        cellIds: [
          'cell-1-5', // 以色列本土（source，F-35/特种部队基地）
          'cell-2-6', // 地中海东岸（空中走廊）
          'cell-3-8', // 阿拉伯半岛北部
          'cell-5-10', // 波斯湾西部海域
          'cell-6-10', // 波斯湾航母战斗群阵位
        ],
      },
      // === 伊朗补给：德黑兰 → 各导弹阵地/革命卫队据点 ===
      {
        id: 'iran-tehran-missile-supply',
        factionId: 'iran',
        type: 'road',
        // 德黑兰(source)→扎格罗斯山脉→核设施周边/导弹阵地（伊朗陆上补给网）
        cellIds: [
          'cell-14-3', // 德黑兰（source，指挥中枢/弹道导弹指挥）
          'cell-13-4', // 德黑兰西郊
          'cell-12-4', // 纳坦兹核设施周边（导弹阵地）
          'cell-13-5', // 扎格罗斯山脉通道
          'cell-13-6', // 福特罗核设施周边（深埋工事/导弹阵地）
        ],
      },
    ],
  },
}

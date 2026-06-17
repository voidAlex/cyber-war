/**
 * 中途岛海战 1942 — map.json 数据。
 *
 * 史实地理（查证自维基/百科）：
 * - 中途岛（Midway Atoll）：太平洋中部环礁，距珍珠港西北约 2100 公里；美军前沿机场/潜艇基地。
 *   日军攻占中途岛既为夺取前沿基地，亦为引诱美军航母救援决战。
 * - 战场为广阔太平洋，几乎没有陆地；航母机动部队（机动部队）与美军特混舰队在数百公里海域机动。
 * - 美军第 16/17 特混舰队（企业/大黄蜂 + 约克城）从东北方向设伏；日军第一航空舰队（赤城/加贺/
 *   苍龙/飞龙）从西北方向逼近中途岛。
 *
 * 网格设计：14×10 方格（cols=14, rows=10，col 0-13，row 0-9）。
 * 地形分布：
 * - 水域（太平洋）：绝大多数 cell 为 water（广阔海域）。
 * - 中途岛（cell-7-5）：唯一陆地，urban terrain（机场/基地），isObjective。
 * - 其余零星珊瑚礁/环礁以 marsh 代理（低防御、高移动消耗）。
 *
 * @module data/midway-1942/map
 */

import type { CampaignMap } from '@/types'

/** 中途岛海战地图网格规模 */
const COLS = 14
const ROWS = 10

/** 中途岛环礁 cell */
const MIDWAY_CELL = 'cell-7-5'

/**
 * 构造中途岛海战地图单元数组（行优先）。
 *
 * 绝大多数为太平洋水域；中途岛为唯一陆地（机场/基地）。
 */
function buildMidwayCells(): CampaignMap['cells'] {
  const cells: CampaignMap['cells'] = []
  // 零星珊瑚礁 cell（marsh 代理，模拟环礁/浅滩）
  const reefCells = new Set<string>([
    'cell-3-3',
    'cell-10-2',
    'cell-4-7',
    'cell-11-8',
  ])
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const id = `cell-${col}-${row}`
      let terrain: CampaignMap['cells'][number]['terrain'] = 'water'
      let movementCost = 1
      let defenseBonus = 0
      let isObjective = false
      let isSupplySource = false

      if (id === MIDWAY_CELL) {
        // 中途岛：陆地（机场/潜艇基地），urban terrain，高防御
        terrain = 'urban'
        movementCost = 2
        defenseBonus = 0.85
        isObjective = true
        isSupplySource = true // 中途岛为美军前沿基地（补给源）
      } else if (reefCells.has(id)) {
        // 珊瑚礁/浅滩：marsh，高移动消耗（航母规避），低防御
        terrain = 'marsh'
        movementCost = 3
        defenseBonus = 0.05
      } else {
        // 太平洋水域
        terrain = 'water'
        movementCost = 1
        defenseBonus = 0
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

/** 中途岛海战地图 */
export const midwayMap: CampaignMap = {
  gridType: 'square',
  cols: COLS,
  rows: ROWS,
  cells: buildMidwayCells(),
  highValueNodes: [
    {
      id: 'midway',
      name: '中途岛 (Midway Atoll)',
      // 美军前沿机场/潜艇基地；日军攻占目标（引诱美军航母决战）
      cellId: 'cell-7-5',
      controlThreshold: 2,
    },
  ],
  /**
   * 补给网络（第 4 批，美/日各一条）。
   *
   * 史实（查证自维基/百科）：
   * - 美军补给：中途岛机场为前沿基地（航空侦察/轰炸出发地），且经珍珠港（后方）补给。
   *   美军特混舰队在海上机动，补给由海上补给舰代理（游戏内简化为中途岛 source 线）。
   * - 日军补给：日军机动部队远离本土单程数千公里作战，补给依赖本土/威克岛前伸；
   *   南云舰队油料/弹药有限（"换弹危机"即弹药调度失误）。
   *
   * 设计：cellIds[0]=source（isSupplySource=true），后续向机动海域延伸。
   * 海战补给线为概念性（舰队海上机动），用中途岛/本土两端 short path 表达。
   */
  supplyNetwork: {
    lines: [
      // === 美军补给：中途岛前沿基地（航空出发/油料补给） ===
      {
        id: 'usa-midway-supply',
        factionId: 'usa',
        type: 'road', // 海上补给线无 road/rail/river 完全对应，用 road 代理（海上航线）
        // 中途岛(source)→东北机动海域（美军特混舰队设伏区）
        cellIds: [
          'cell-7-5', // 中途岛（source，美军前沿基地）
          'cell-8-4', // 中途岛东北近海
          'cell-9-3', // 东北机动海域（第 16/17 特混舰队设伏）
          'cell-10-3', // 东北远海（美军舰队退避/追击区）
        ],
      },
      // === 日军补给：威克岛前伸 → 西北机动海域（南云舰队） ===
      {
        id: 'japan-wake-supply',
        factionId: 'japan',
        type: 'road',
        // 威克岛方向(source)→西北机动海域（日军第一航空舰队逼近中途岛）
        cellIds: [
          'cell-0-2', // 威克岛方向（source，日军前伸基地/油料补给）
          'cell-2-3', // 西北近海
          'cell-4-4', // 西北机动海域（南云舰队）
          'cell-6-5', // 中途岛西北近海（日军舰队决战阵位）
        ],
      },
    ],
  },
}

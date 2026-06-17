/**
 * 俄乌冲突 2022 — map.json 数据。
 *
 * 史实地理（查证自维基/百科）：
 * - 第聂伯河（Dnipro）：自北向南纵贯乌克兰中部，将国土分为东西两岸；下游赫尔松在河口附近。
 * - 基辅（Kyiv）：乌克兰首都，第聂伯河中游西岸/两岸；俄军北线主攻目标，2022 年攻势被乌军挫败。
 * - 哈尔科夫（Kharkiv）：乌克兰第二大城市，东北部，邻近俄边境；俄军东线主攻。
 * - 赫尔松（Kherson）：南部，第聂伯河下游河口；俄军南线（克里米亚北上）首座陷落州府，乌军 11 月反攻收复。
 * - 顿涅茨克（Donetsk）：东部顿巴斯核心；2014 年起俄系分离武装控制，2022 战争焦点之一。
 * - 马里乌波尔（Mariupol）：亚速海港口，亚速钢铁厂围困战闻名；乌军坚守至 5 月陷落。
 *
 * 网格设计：16×12 方格（cols=16, rows=12，col 0-15，row 0-11）。
 * 地形分布：
 * - 第聂伯河水域：col=7 纵贯（南北）。
 * - 城市（urban）：基辅(cell-7-2)、哈尔科夫(cell-12-4)、赫尔松(cell-6-10)、顿涅茨克(cell-13-8)、
 *   马里乌波尔(cell-11-10)。
 * - 边境/后方：北侧（row 0-1）为俄罗斯/白俄罗斯边境（俄军集结）；西侧（col 0-1）为利沃夫方向
 *   （乌军补给源/西方军援入口）。
 *
 * @module data/ukraine-2022/map
 */

import type { CampaignMap } from '@/types'

/** 俄乌冲突地图网格规模 */
const COLS = 16
const ROWS = 12

/** 第聂伯河纵贯列（水） */
const DNIPRO_COL = 7

/**
 * 构造俄乌冲突地图单元数组（行优先）。
 *
 * 地形规则（按 cell 坐标判定）：
 * - 第聂伯河水域：col===7（高移动消耗、低防御，渡河瓶颈）。
 * - 城市 urban：基辅/哈尔科夫/赫尔松/顿涅茨克/马里乌波尔（高防御加成，isObjective）。
 * - 山地：喀尔巴阡山脉（西南 col 1-3,row 9-11，模拟利沃夫后方屏障）与顿巴斯丘陵（col 12-15,row 6-9）。
 * - 森林/平原：乌克兰大平原主体。
 */
function buildUkraineCells(): CampaignMap['cells'] {
  const cells: CampaignMap['cells'] = []
  // 城市 cell 集合（id → 是否目标）
  const urbanCells = new Set<string>([
    'cell-7-2', // 基辅
    'cell-12-4', // 哈尔科夫
    'cell-6-10', // 赫尔松
    'cell-13-8', // 顿涅茨克
    'cell-11-10', // 马里乌波尔
  ])
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const id = `cell-${col}-${row}`
      let terrain: CampaignMap['cells'][number]['terrain'] = 'plain'
      let movementCost = 1
      let defenseBonus = 0.1
      let isObjective = false
      let isSupplySource = false

      if (col === DNIPRO_COL) {
        // 第聂伯河：水域，高移动消耗（渡河瓶颈），低防御
        terrain = 'water'
        movementCost = 4
        defenseBonus = 0
      } else if (urbanCells.has(id)) {
        // 城市：高防御加成（城市战），关键目标
        terrain = 'urban'
        movementCost = 2
        defenseBonus = 0.85
        isObjective = true
      } else if (col >= 12 && row >= 6 && row <= 9) {
        // 顿巴斯丘陵（东部）：山地
        terrain = 'mountain'
        movementCost = 3
        defenseBonus = 0.35
      } else if (col <= 3 && row >= 9) {
        // 喀尔巴阡山脉（西南）：山地（利沃夫后方屏障）
        terrain = 'mountain'
        movementCost = 3
        defenseBonus = 0.3
      } else if (col <= 2 && row <= 4) {
        // 西北森林（白俄罗斯/波兰边境森林地带）
        terrain = 'forest'
        movementCost = 2
        defenseBonus = 0.25
      } else {
        // 乌克兰大平原主体
        terrain = 'plain'
        movementCost = 1
        defenseBonus = 0.1
      }

      // === 补给源标记 ===
      // 乌军补给源：利沃夫方向（cell-1-6，西方军援入口 + 后勤枢纽）
      if (col === 1 && row === 6) {
        isSupplySource = true
      }
      // 俄军补给源：别尔哥罗德方向（cell-15-2，俄境后勤集结，东线/北线补给起点）
      if (col === 15 && row === 2) {
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

/** 俄乌冲突地图 */
export const ukraineMap: CampaignMap = {
  gridType: 'square',
  cols: COLS,
  rows: ROWS,
  cells: buildUkraineCells(),
  highValueNodes: [
    {
      id: 'kyiv',
      name: '基辅 (Kyiv)',
      // 乌克兰首都，俄军北线主攻目标（2022 基辅攻势被乌军挫败）
      cellId: 'cell-7-2',
      controlThreshold: 2,
    },
    {
      id: 'kharkiv',
      name: '哈尔科夫 (Kharkiv)',
      // 乌克兰第二大城市，东北部俄军东线主攻
      cellId: 'cell-12-4',
      controlThreshold: 2,
    },
    {
      id: 'kherson',
      name: '赫尔松 (Kherson)',
      // 南部第聂伯河口，俄军南线首陷州府（乌军 11 月反攻收复）
      cellId: 'cell-6-10',
      controlThreshold: 2,
    },
    {
      id: 'donetsk',
      name: '顿涅茨克 (Donetsk)',
      // 顿巴斯核心（2014 起俄系分离武装控制）
      cellId: 'cell-13-8',
      controlThreshold: 2,
    },
    {
      id: 'mariupol',
      name: '马里乌波尔 (Mariupol)',
      // 亚速海港口，亚速钢铁厂围困战闻名
      cellId: 'cell-11-10',
      controlThreshold: 2,
    },
  ],
  /**
   * 补给网络（第 4 批，乌/俄各一条）。
   *
   * 史实（查证自维基/百科/新闻）：
   * - 乌军补给：自利沃夫（西方边境，西方军援入口）经公路网至基辅，支撑首都防御与全国调配。
   * - 俄军补给：自别尔哥罗德（俄境后勤枢纽）经铁路至哈尔科夫前线；俄军铁路补给线长且脆弱，
   *   乌军多次打击俄军后勤列车/弹药库。
   *
   * 设计：cellIds[0]=source（isSupplySource=true），后续向前线延伸。
   * computeSupplyConnectivity 沿路径判连通性，敌方占据任一中间 cell 即阻断。
   */
  supplyNetwork: {
    lines: [
      // === 乌军补给动脉：利沃夫→基辅（西方军援 + 后勤调配） ===
      {
        id: 'ukr-lviv-kyiv-supply',
        factionId: 'ukraine',
        type: 'road',
        // 利沃夫(source)→公路网→基辅（乌军生命线，西方军援由此分发）
        cellIds: [
          'cell-1-6', // 利沃夫方向（source，西方军援入口/后勤枢纽）
          'cell-2-5', // 西部公路
          'cell-3-4', // 中西部
          'cell-4-3', // 中部
          'cell-5-3', // 基辅西郊
          'cell-6-2', // 基辅西岸
          'cell-7-2', // 基辅（首都，防御中枢）
        ],
      },
      // === 俄军补给动脉：别尔哥罗德→哈尔科夫（铁路补给，脆弱长线） ===
      {
        id: 'rus-belgorod-kharkiv-supply',
        factionId: 'russia',
        type: 'rail',
        // 别尔哥罗德(source)→铁路→哈尔科夫前线（俄军东线/北线生命线）
        cellIds: [
          'cell-15-2', // 别尔哥罗德方向（source，俄境后勤集结）
          'cell-14-3', // 俄乌边境铁路
          'cell-13-4', // 哈尔科夫东郊
          'cell-12-4', // 哈尔科夫（东线主攻目标/前线）
        ],
      },
    ],
  },
}

/**
 * 官渡之战（公元 200 年）— map.json 数据。
 *
 * 史实地理（查证自《三国志》《资治通鉴》/百科）：
 * - 黄河：自西向东流经战场北缘，白马（今河南滑县北）在黄河南岸，为袁绍南渡桥头堡；
 *   延津在白马西南，亦黄河南岸要地；官渡在黄河南岸、鸿沟水系汇口，曹军大营所在。
 * - 官渡大营：曹操凭借鸿沟与官渡水构筑的坚固营垒，袁绍屡攻不下，相持核心。
 * - 乌巢（今河南延津东南）：袁绍囤积粮草辎重之所，距袁营 40 里，守备淳于琼。
 *   曹操夜袭乌巢焚粮，是战役转折点。
 * - 许都（今河南许昌）：曹操大后方都城，曹军补给源头。
 * - 邺城（今河北临漳）：袁绍老巢，袁军补给源头；黎阳（今河南浚县东，黄河北岸）为袁军
 *   南渡集结地。
 *
 * 网格设计：12×9 方格（cols=12, rows=8 → 实为 rows=8，但本剧本按 12×9=col 0-11,row 0-8）。
 * 地形分布：
 * - 黄河水域：纵贯北部（row=0、1 北缘 + 东侧 col=11 纵贯），高移动消耗、低防御。
 * - 官渡大营（cell-5-4）：曹军核心堡垒，fortress terrain，防御加成极高。
 * - 平原/森林：中原战场主体。
 * - 乌巢（cell-8-2）：袁军粮仓，平原 cell 标 isObjective（不计入 fortress，仅高价值节点）。
 * - 白马（cell-8-1）、延津（cell-7-2）：黄河南岸据点，高价值节点。
 *
 * @module data/guandu-200/map
 */

import type { CampaignMap } from '@/types'

/** 官渡地图网格规模 */
const COLS = 12
const ROWS = 9

/**
 * 构造官渡地图单元数组（行优先）。
 *
 * 地形规则（按 cell 坐标判定）：
 * - 黄河水域：row<=1（北缘）或 col===11（东缘）。
 * - 官渡大营：cell-5-4 fortress。
 * - 平原/森林：其余按地理密度分布。
 */
function buildGuanduCells(): CampaignMap['cells'] {
  const cells: CampaignMap['cells'] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const id = `cell-${col}-${row}`
      let terrain: CampaignMap['cells'][number]['terrain'] = 'plain'
      let movementCost = 1
      let defenseBonus = 0.1
      let isObjective = false
      let isSupplySource = false

      // === 黄河水域：北部 row<=1 + 东缘 col===11 ===
      if (row <= 1 || col === 11) {
        terrain = 'water'
        movementCost = 4
        defenseBonus = 0
      } else if (col === 5 && row === 4) {
        // 官渡大营：曹军核心堡垒（曹军据守，袁军主攻目标）
        terrain = 'fortress'
        movementCost = 3
        defenseBonus = 0.85
        isObjective = true
      } else if (row <= 3 && col >= 7) {
        // 黄河南岸袁军桥头堡一带（白马/延津/乌巢周边）：多为平原，偶有森林
        if ((col === 7 && row === 3) || (col === 9 && row === 3)) {
          terrain = 'forest'
          movementCost = 2
          defenseBonus = 0.25
        } else {
          terrain = 'plain'
          movementCost = 1
          defenseBonus = 0.1
        }
      } else if (row >= 6 && col <= 2) {
        // 西南许都方向：森林（曹军后方腹地）
        terrain = 'forest'
        movementCost = 2
        defenseBonus = 0.25
      } else if (col <= 2 && row === 7) {
        // 许都（cell-1-7 附近）：曹军补给源（城市/据点）
        terrain = 'plain'
        movementCost = 1
        defenseBonus = 0.3
      } else {
        // 中原战场主体：平原
        terrain = 'plain'
        movementCost = 1
        defenseBonus = 0.1
      }

      // === 补给源标记 ===
      // 曹军补给源：许都方向（cell-1-7，许都模拟）
      if (col === 1 && row === 7) {
        isSupplySource = true
      }
      // 袁军补给源：邺城（cell-10-0，黄河北岸袁绍老巢）
      if (col === 10 && row === 0) {
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

/** 官渡地图 */
export const guanduMap: CampaignMap = {
  gridType: 'square',
  cols: COLS,
  rows: ROWS,
  cells: buildGuanduCells(),
  highValueNodes: [
    {
      id: 'guandu-camp',
      name: '官渡大营',
      // 曹军核心营垒（曹操凭鸿沟/官渡水据守，袁绍屡攻不下）
      cellId: 'cell-5-4',
      controlThreshold: 2,
    },
    {
      id: 'wuchao-granary',
      name: '乌巢粮仓',
      // 袁军辎重囤积之所（淳于琼守备，曹操夜袭焚粮，战役转折点）
      cellId: 'cell-8-2',
      controlThreshold: 2,
    },
    {
      id: 'baima',
      name: '白马',
      // 黄河南岸要地（关羽斩颜良解白马之围，建安五年四月）
      cellId: 'cell-8-1',
      controlThreshold: 2,
    },
    {
      id: 'yanjin',
      name: '延津',
      // 黄河南岸据点（曹操诱敌延津、文丑败亡处）
      cellId: 'cell-7-2',
      controlThreshold: 2,
    },
  ],
  /**
   * 补给网络（第 4 批，曹/袁各一条 + 袁军乌巢支线）。
   *
   * 史实（查证自《三国志》《资治通鉴》）：
   * - 曹军补给：自许都（曹操大后方都城，屯田屯粮基地）北上经鸿沟水系至官渡大营，
   *   支撑曹军据守。袁军若切断鸿沟沿线即断曹军粮。
   * - 袁军补给：自邺城（袁绍老巢，粮草主仓）南下渡黄河至黎阳（南渡集结地），
   *   再前伸至官渡前线；另有支线连乌巢粮仓（囤积辎重之所，淳于琼驻守）。
   *   曹军夜袭乌巢焚粮即切断此支线，致袁军军心崩溃。
   *
   * 设计：cellIds[0]=source（isSupplySource=true），后续向前线延伸。
   * computeSupplyConnectivity 沿路径判连通性，敌方占据任一中间 cell 即阻断。
   */
  supplyNetwork: {
    lines: [
      // === 曹军补给动脉：许都→鸿沟→官渡大营 ===
      {
        id: 'cao-xuchu-supply',
        factionId: 'caocao',
        type: 'road',
        // 许都(source)→北上鸿沟沿线→官渡大营（曹军生命线）
        cellIds: [
          'cell-1-7', // 许都（source，曹军后方都城/屯粮基地）
          'cell-2-6', // 许都北郊森林
          'cell-3-5', // 鸿沟水系南段
          'cell-4-5', // 鸿沟水系北段
          'cell-5-4', // 官渡大营（曹军前线中枢）
        ],
      },
      // === 袁军补给主干：邺城→黎阳→官渡前线 ===
      {
        id: 'yuan-yecheng-supply',
        factionId: 'yuanshao',
        type: 'road',
        // 邺城(source)→南渡黄河→黎阳集结→官渡前线（袁军十万大军生命线）
        cellIds: [
          'cell-10-0', // 邺城（source，袁绍老巢/粮草主仓）
          'cell-10-1', // 黄河北岸南渡点
          'cell-9-1', // 黎阳（黄河南岸袁军集结地）
          'cell-8-1', // 白马（南岸桥头堡）
          'cell-7-2', // 延津（前伸据点）
          'cell-6-3', // 官渡前线袁军大营附近
        ],
      },
      // === 袁军乌巢粮仓支线：黎阳→乌巢（辎重囤积） ===
      {
        id: 'yuan-wuchao-supply',
        factionId: 'yuanshao',
        type: 'road',
        // 黎阳集结→东进乌巢（袁军粮草辎重囤积之所，淳于琼驻守）
        // 曹军夜袭乌巢焚毁此节点即切断袁军粮源，致张郃高览降、袁军崩溃
        cellIds: [
          'cell-9-1', // 黎阳（袁军南岸集结地）
          'cell-9-2', // 黎阳东郊
          'cell-8-2', // 乌巢粮仓（袁军辎重囤积核心）
        ],
      },
    ],
  },
}

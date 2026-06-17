/**
 * 官渡之战（公元 200 年）— 内置战役包 barrel。
 *
 * 七文件按史实拆分（见各文件头注释的史实依据）：
 * - manifest：scenarioId=guandu-200，固定 seed，玩家可选曹（守）/袁（攻）。
 * - map：黄河→官渡大营→许都，含乌巢/白马/延津高价值节点 + 曹/袁补给网络。
 * - factions：曹蓝/袁灰，交战状态。
 * - units：曹军 7 单位（精锐步兵+弓弩+虎豹骑+补给）vs 袁军 14 单位（十万众）。
 * - commanders：曹操（知人善任）/袁绍（优柔寡断）。
 * - rules：冷兵器攻坚（强弩压制、要塞防御、骑兵突击）+ 许攸来投/奇袭乌巢事件与决策。
 * - victory：曹=守至回合上限或重创袁军；袁=占官渡大营或重创曹军。
 *
 * @module data/guandu-200
 */

import type { CampaignPayload } from '@/types'
import { guanduManifest } from './manifest'
import { guanduMap } from './map'
import { guanduFactions } from './factions'
import { guanduUnits } from './units'
import { guanduCommanders } from './commanders'
import { guanduRules } from './rules'
import { guanduVictory } from './victory'

// 导出各文件（供 UI 直接引用展示）
export { guanduManifest } from './manifest'
export { guanduMap } from './map'
export { guanduFactions } from './factions'
export { guanduUnits } from './units'
export { guanduCommanders } from './commanders'
export { guanduRules } from './rules'
export { guanduVictory } from './victory'

/**
 * 官渡之战 200 默认示例战役包（可加载的 CampaignPayload）。
 *
 * scenarioId=guandu-200；开局流程引用此 payload：选战役包 → initSave → 加载。
 */
export const guanduCampaign: CampaignPayload = {
  manifest: guanduManifest,
  map: guanduMap,
  factions: guanduFactions,
  units: guanduUnits,
  commanders: guanduCommanders,
  rules: guanduRules,
  victory: guanduVictory,
}

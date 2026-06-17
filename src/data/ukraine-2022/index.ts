/**
 * 俄乌冲突 2022 — 内置战役包 barrel。
 *
 * 七文件按史实拆分（见各文件头注释的史实依据）：
 * - manifest：scenarioId=ukraine-2022，固定 seed，玩家可选乌（守）/俄（攻）。
 * - map：第聂伯河纵贯，基辅/哈尔科夫/赫尔松/顿涅茨克/马里乌波尔城市节点 + 乌/俄补给网络。
 * - factions：乌蓝/俄灰，交战状态。
 * - units：乌军 10 单位（步兵+机械化+炮兵+防空+无人机）vs 俄军 14 单位（装甲+机械化+炮兵+空降+防空+无人机）。
 * - commanders：泽连斯基（灵活抵抗）/普京（战略耐心）。
 * - rules：现代机械化战争（远程炮兵压制、城市防御、补给脆弱）+ 西方军援/无人机打击事件与决策。
 * - victory：乌=守至回合上限或收复赫尔松/保住基辅；俄=占基辅或重创乌军。
 *
 * @module data/ukraine-2022
 */

import type { CampaignPayload } from '@/types'
import { ukraineManifest } from './manifest'
import { ukraineMap } from './map'
import { ukraineFactions } from './factions'
import { ukraineUnits } from './units'
import { ukraineCommanders } from './commanders'
import { ukraineRules } from './rules'
import { ukraineVictory } from './victory'

// 导出各文件（供 UI 直接引用展示）
export { ukraineManifest } from './manifest'
export { ukraineMap } from './map'
export { ukraineFactions } from './factions'
export { ukraineUnits } from './units'
export { ukraineCommanders } from './commanders'
export { ukraineRules } from './rules'
export { ukraineVictory } from './victory'

/**
 * 俄乌冲突 2022 内置战役包（可加载的 CampaignPayload）。
 *
 * scenarioId=ukraine-2022；开局流程引用此 payload：选战役包 → initSave → 加载。
 */
export const ukraineCampaign: CampaignPayload = {
  manifest: ukraineManifest,
  map: ukraineMap,
  factions: ukraineFactions,
  units: ukraineUnits,
  commanders: ukraineCommanders,
  rules: ukraineRules,
  victory: ukraineVictory,
}

/**
 * 凡尔登战役 1916 — 默认示例战役包 barrel。
 *
 * 作为产品默认示例战役包（doc/prd-v1.0.md §7.2），导出可加载的 CampaignPayload。
 * 用于：① 加载验证（ZIP 导入闭环，验收#5）② 端到端验收 ③ AI 行为合理性校验（史实可对照）。
 *
 * 七文件按史实拆分（见各文件头注释的史实依据）：
 * - manifest：scenarioId=verdun-1916，固定 seed，玩家可选法/德。
 * - map：默兹河两岸网格（含 plain/forest/mountain/要塞 terrain + 高 defenseBonus）。
 * - factions：法蓝/德灰，敌对。
 * - units：法德步兵师/炮兵/要塞守备/侦察，按史实位置部署。
 * - commanders：贝当/尼韦勒/法金汉/皇太子，人格数值合理。
 * - rules：堑壕战（炮击压制、要塞防御加成、消耗损耗、半衰 halfLifeTurns=3）。
 * - victory：德=占领凡尔登核心要塞或法军战损超阈值；法=守至回合上限或反攻收复杜奥蒙。
 *
 * @module data/verdun-1916
 */

import type { CampaignPayload } from '@/types'
import { verdunManifest } from './manifest'
import { verdunMap } from './map'
import { verdunFactions } from './factions'
import { verdunUnits } from './units'
import { verdunCommanders } from './commanders'
import { verdunRules } from './rules'
import { verdunVictory } from './victory'

// 导出各文件（供 UI 直接引用展示）
export { verdunManifest } from './manifest'
export { verdunMap } from './map'
export { verdunFactions } from './factions'
export { verdunUnits } from './units'
export { verdunCommanders } from './commanders'
export { verdunRules } from './rules'
export { verdunVictory } from './victory'

/**
 * 凡尔登 1916 默认示例战役包（可加载的 CampaignPayload）。
 *
 * 默认随产品分发，开局流程引用此 payload：选战役包 → initSave（写 manifest +
 * 初始 world-state）→ 加载。
 */
export const verdunCampaign: CampaignPayload = {
  manifest: verdunManifest,
  map: verdunMap,
  factions: verdunFactions,
  units: verdunUnits,
  commanders: verdunCommanders,
  rules: verdunRules,
  victory: verdunVictory,
}

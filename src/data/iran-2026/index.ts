/**
 * 美以伊冲突 2026 — 内置战役包 barrel。
 *
 * 七文件按设定拆分（见各文件头注释的设定依据）：
 * - manifest：scenarioId=iran-2026，固定 seed，玩家可选美以（攻）/伊朗（守反击）。
 * - map：波斯湾 + 霍尔木兹海峡 + 伊朗本土山地，纳坦兹/福特罗核设施节点 + 美以/伊朗补给网络。
 * - factions：美以蓝/伊朗绿，交战状态。
 * - units：美以 8 单位（航母+F-35+驱逐舰+战斧+特种部队）vs 伊朗 9 单位（弹道导弹+IRGC+防空+快艇+无人机）。
 * - commanders：内塔尼亚胡（果断先发制人）/哈梅内伊（强硬抵抗消耗战）。
 * - rules：现代精确打击 + 不对称反击（高消耗、深埋工事防御）+ 伊朗导弹反击/海峡封锁事件与决策。
 * - victory：美以=摧毁纳坦兹+福特罗；伊朗=重创美军航母（战损 45%）或守至回合上限。
 *
 * @module data/iran-2026
 */

import type { CampaignPayload } from '@/types'
import { iranManifest } from './manifest'
import { iranMap } from './map'
import { iranFactions } from './factions'
import { iranUnits } from './units'
import { iranCommanders } from './commanders'
import { iranRules } from './rules'
import { iranVictory } from './victory'

// 导出各文件（供 UI 直接引用展示）
export { iranManifest } from './manifest'
export { iranMap } from './map'
export { iranFactions } from './factions'
export { iranUnits } from './units'
export { iranCommanders } from './commanders'
export { iranRules } from './rules'
export { iranVictory } from './victory'

/**
 * 美以伊冲突 2026 内置战役包（可加载的 CampaignPayload）。
 *
 * scenarioId=iran-2026；开局流程引用此 payload：选战役包 → initSave → 加载。
 */
export const iranCampaign: CampaignPayload = {
  manifest: iranManifest,
  map: iranMap,
  factions: iranFactions,
  units: iranUnits,
  commanders: iranCommanders,
  rules: iranRules,
  victory: iranVictory,
}

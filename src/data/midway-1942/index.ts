/**
 * 中途岛海战 1942 — 内置战役包 barrel。
 *
 * 七文件按史实拆分（见各文件头注释的史实依据）：
 * - manifest：scenarioId=midway-1942，固定 seed，玩家可选美（守）/日（攻）。
 * - map：太平洋水域 + 中途岛机场节点 + 美/日海上补给线。
 * - factions：美蓝/日红，交战状态。
 * - units：美军 8 单位（3 航母+巡洋舰+驱逐舰+岸基航空）vs 日军 10 单位（4 航母+战列舰+巡洋舰+驱逐舰）。
 * - commanders：尼米兹（情报至上）/山本五十六（赌徒直觉）。
 * - rules：航母海战（高消耗、俯冲轰炸致命）+ JN-25 破译/南云换弹危机事件与决策。
 * - victory：美=重创日军航母（战损 40%）或保住中途岛；日=占中途岛或重创美军。
 *
 * @module data/midway-1942
 */

import type { CampaignPayload } from '@/types'
import { midwayManifest } from './manifest'
import { midwayMap } from './map'
import { midwayFactions } from './factions'
import { midwayUnits } from './units'
import { midwayCommanders } from './commanders'
import { midwayRules } from './rules'
import { midwayVictory } from './victory'

// 导出各文件（供 UI 直接引用展示）
export { midwayManifest } from './manifest'
export { midwayMap } from './map'
export { midwayFactions } from './factions'
export { midwayUnits } from './units'
export { midwayCommanders } from './commanders'
export { midwayRules } from './rules'
export { midwayVictory } from './victory'

/**
 * 中途岛海战 1942 内置战役包（可加载的 CampaignPayload）。
 *
 * scenarioId=midway-1942；开局流程引用此 payload：选战役包 → initSave → 加载。
 */
export const midwayCampaign: CampaignPayload = {
  manifest: midwayManifest,
  map: midwayMap,
  factions: midwayFactions,
  units: midwayUnits,
  commanders: midwayCommanders,
  rules: midwayRules,
  victory: midwayVictory,
}

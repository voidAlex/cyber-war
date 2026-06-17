/**
 * 美以伊冲突 2026 — factions.json 数据。
 *
 * 阵营设定（虚构近未来剧本）：
 * - 美以联军（攻）：蓝（#2563EB）。美军波斯湾航母战斗群 + F-35 隐身战机 + 战斧巡航导弹 +
 *   特种部队；以色列 F-35 与情报支援。先发制人精确打击伊朗核设施。
 * - 伊朗（守反击）：绿（#059669，伊朗国旗色之一）。弹道导弹（Sejjil/Emad）+ 革命卫队（IRGC）+
 *   S-300/Bavar-373 防空 + 导弹快艇群（霍尔木兹封锁）+ Shahed-136 无人机。
 * - 双方敌对（互为唯一交战方，无第三方阵营）。
 *
 * @module data/iran-2026/factions
 */

import type { CampaignFaction } from '@/types'

/** 美以伊冲突阵营列表 */
export const iranFactions: CampaignFaction[] = [
  {
    id: 'usisrael',
    name: '美以联军 (US-Israel Coalition)',
    color: '#2563EB', // 美军蓝
    side: 'player',
    commanderId: 'netanyahu',
    // 注：战区司令角色由 rules.aiRoles 定义（美军中央司令 ai-uscentcom-commander）。
    supply: {
      // 美以联军开局物资充足（精确打击弹药储备）
      supplies: 75,
      ammunition: 80,
      // 海空作战燃料需求大
      fuel: 70,
    },
    // 美以对外信任度：仅对伊朗敌对（5）
    trust: { iran: 5 },
    // 第 5 批：美以-伊朗定性关系——交战状态
    relations: { iran: 'at_war' },
    doctrineTags: ['先发制人', '精确打击', '隐身突防', '海空一体', '斩首核设施'],
    description:
      '美以联军对伊朗核设施实施先发制人精确打击，企图摧毁伊朗核能力。美军波斯湾航母战斗群' +
      '提供海空打击（战斧巡航导弹 + 舰载机），F-35 隐身战机突防摧毁深埋工事，特种部队执行' +
      '侦察与定点清除。内塔尼亚胡主导，果断先发制人。',
  },
  {
    id: 'iran',
    name: '伊朗伊斯兰共和国 (Iran)',
    color: '#059669', // 伊朗绿
    side: 'enemy',
    commanderId: 'khamenei',
    // 注：战区司令角色由 rules.aiRoles 定义（革命卫队司令 ai-irgc-commander）。
    supply: {
      // 伊朗开局物资中等（本土作战 + 储备）
      supplies: 65,
      ammunition: 75,
      // 伊朗燃料自给（产油国）
      fuel: 75,
    },
    trust: { usisrael: 5 },
    // 第 5 批：伊朗-美以定性关系——交战状态
    relations: { usisrael: 'at_war' },
    doctrineTags: ['强硬抵抗', '弹道导弹反击', '消耗战', '非对称封锁', '无人机饱和'],
    description:
      '伊朗以弹道导弹（Sejjil/Emad）反击以色列与美军波斯湾舰队，革命卫队（IRGC）导弹快艇群' +
      '封锁霍尔木兹海峡（全球石油咽喉），Shahed-136 无人机群饱和攻击。最高领袖主导"强硬抵抗"消耗战略，' +
      '以非对称手段反击美以联军，拖入持久消耗。',
  },
]

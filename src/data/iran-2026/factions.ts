/**
 * 美以伊冲突 2026 — factions.json 数据。
 *
 * 第 3 批多阵营拆分：原"美以联军"（usisrael 单阵营）拆为 3 方：
 * - 美国（usa）：美军波斯湾航母战斗群 + F-35（部分）+ 战斧巡航导弹 + 驱逐舰 + 特种部队。
 * - 以色列（israel）：F-35I Adir 主力（钻地弹摧毁深埋工事）+ 情报支援。
 * - 伊朗（iran）：弹道导弹（Sejjil/Emad）+ 革命卫队（IRGC）+ 防空 + 导弹快艇 + 无人机。
 *
 * 关系矩阵（第 5 批多阵营 + 第 3 批拆分）：
 * - usa ↔ israel：allied（结盟，但目标不完全一致——以更激进）。
 * - usa ↔ iran：at_war（交战）。
 * - israel ↔ iran：at_war（交战）。
 *
 * @module data/iran-2026/factions
 */

import type { CampaignFaction } from '@/types'

/** 美以伊冲突阵营列表 */
export const iranFactions: CampaignFaction[] = [
  // === 美国（usa，第 3 批从 usisrael 拆出） ===
  {
    id: 'usa',
    name: '美国 (United States)',
    color: '#2563EB', // 美军蓝
    side: 'player',
    // 第 2+3 批：commanderId = CENTCOM 司令（职业军人）。
    commanderId: 'centcom-commander',
    // 注：战区司令角色由 rules.aiRoles 定义（美军舰队司令 ai-usfleet-commander）。
    supply: {
      // 美军开局物资充足（精确打击弹药储备）
      supplies: 75,
      ammunition: 80,
      // 海空作战燃料需求大
      fuel: 70,
    },
    // 美国对外信任度：对以色列盟友高（85），对伊朗敌对（5）
    trust: { israel: 85, iran: 5 },
    // 第 5 批 + 第 3 批：美-以结盟（但目标不完全一致），美-伊交战
    relations: { israel: 'allied', iran: 'at_war' },
    doctrineTags: ['精确打击', '隐身突防', '海空一体', '联合作战', '战区统筹'],
    publicWill: 55,
    internationalOpinion: 60,
    description:
      '美军中央司令部（CENTCOM）对伊朗核设施实施先发制人精确打击。波斯湾航母战斗群提供海空打击' +
      '（战斧巡航导弹 + 舰载机），F-35 隐身战机突防，宙斯盾驱逐舰反导掩护航母，特种部队执行' +
      '侦察与定点清除。受以色列政治推动参与联合作战，但警惕陷入中东持久战。',
  },
  // === 以色列（israel，第 3 批从 usisrael 拆出） ===
  {
    id: 'israel',
    name: '以色列 (Israel)',
    color: '#1e40af', // 以色列深蓝
    side: 'player',
    // 第 2+3 批：commanderId = IDF 总参谋长（职业军人）。
    commanderId: 'idf-chief',
    supply: {
      // 以色列本土作战储备（F-35/钻地弹/特种部队）
      supplies: 70,
      ammunition: 78,
      fuel: 68,
    },
    trust: { usa: 85, iran: 5 },
    // 第 3 批：以-美结盟，以-伊交战
    relations: { usa: 'allied', iran: 'at_war' },
    doctrineTags: ['先发制人', '精确打击', '隐身突防', '斩首核设施', '果断决策'],
    publicWill: 65, // 以色列全民共识伊朗核威胁
    internationalOpinion: 55,
    description:
      '以色列国防军（IDF）以 F-35I Adir 隐身战机 + 钻地弹（GBU-28/Bunker Buster）突防摧毁' +
      '伊朗深埋核工事，特种部队（Sayeret Matkal）执行侦察与定点清除。内塔尼亚胡主导先发制人战略，' +
      '推动美军参与联合作战。比美方更激进（视伊朗核能力为生存威胁）。',
  },
  // === 伊朗（iran） ===
  {
    id: 'iran',
    name: '伊朗伊斯兰共和国 (Iran)',
    color: '#059669', // 伊朗绿
    side: 'enemy',
    // 第 2+3 批：commanderId = IRGC 司令（职业军人）。
    commanderId: 'irgc-commander',
    // 注：战区司令角色由 rules.aiRoles 定义（导弹部队司令 ai-iran-missile-commander）。
    supply: {
      // 伊朗开局物资中等（本土作战 + 储备）
      supplies: 65,
      ammunition: 75,
      // 伊朗燃料自给（产油国）
      fuel: 75,
    },
    trust: { usa: 5, israel: 5 },
    // 第 3 批：伊-美交战，伊-以交战
    relations: { usa: 'at_war', israel: 'at_war' },
    doctrineTags: ['强硬抵抗', '弹道导弹反击', '消耗战', '非对称封锁', '无人机饱和'],
    publicWill: 75,
    internationalOpinion: 20,
    description:
      '伊朗以弹道导弹（Sejjil/Emad）反击以色列与美军波斯湾舰队，革命卫队（IRGC）导弹快艇群' +
      '封锁霍尔木兹海峡（全球石油咽喉），Shahed-136 无人机群饱和攻击。IRGC 总司令主导"强硬抵抗"' +
      '消耗战略，以非对称手段反击美以，拖入持久消耗。',
  },
]

/**
 * 美以伊冲突 2026 — commanders.json 数据。
 *
 * 指挥官设定（虚构近未来剧本，人格数值按重写计划「人格数值基底」设计）：
 *
 * 美以联军：
 * - 内塔尼亚胡 Netanyahu：以色列总理（联军主导者），果断先发制人，主张摧毁伊朗核能力。
 *   → aggression 高、obedience 中高、tempo=rapid（果断突袭）。
 *
 * 伊朗：
 * - 哈梅内伊 Khamenei：伊朗最高领袖，"强硬抵抗消耗战"，以非对称手段反击。
 *   → aggression 中低、obedience 低（独断专行）、tempo=methodical（消耗持久）。
 *
 * @module data/iran-2026/commanders
 */

import type { CampaignCommander } from '@/types'

/** 美以伊冲突指挥官人格列表 */
export const iranCommanders: CampaignCommander[] = [
  // === 美以联军 ===
  {
    id: 'netanyahu',
    name: '本雅明·内塔尼亚胡 (Benjamin Netanyahu)',
    rank: '以色列总理（美以联军政治主导者）',
    factionId: 'usisrael',
    personality:
      '果断先发制人的鹰派领袖。坚信伊朗核能力是以色列生存的根本威胁，主张以精确打击' +
      '"斩首"伊朗核设施，趁其核突破前摧毁之。崇尚隐身突防 + 精确打击的"外科手术"，' +
      '敢冒地区冲突升级风险达成战略目标。对美方有政治影响力，推动美军参与联合作战。' +
      '决策果断、不犹豫，把握战机窗口。',
    // 先发制人 + 果断突袭，aggression 高
    aggression: 0.8,
    // obedience 中高（对国内政治框架负责，但战略自主性强）
    obedience: 0.7,
    preferredTempo: 'rapid',
    doctrineTags: ['先发制人', '精确打击', '隐身突防', '斩首核设施', '果断决策'],
  },
  // === 伊朗 ===
  {
    id: 'khamenei',
    name: '阿里·哈梅内伊 (Ali Khamenei)',
    rank: '伊朗最高领袖（革命卫队最高统帅）',
    factionId: 'iran',
    personality:
      '强硬抵抗消耗战的最高领袖。面对美以先发打击，主张以弹道导弹反击 + 革命卫队非对称作战 + ' +
      '霍尔木兹海峡封锁拖入持久消耗，让美以付出不可承受代价。深信"抵抗经济"与消耗战略能' +
      '瓦解联军政治意志。独断专行、不纳异议，对革命卫队（IRGC）绝对掌控。崇尚以非对称手段' +
      '（无人机群/导弹快艇 swarm）反击强敌。',
    // 强硬抵抗 + 消耗，aggression 中低（不追求速胜，重消耗）
    aggression: 0.4,
    // obedience 低（最高领袖独断专行，无人可抗命）
    obedience: 0.3,
    preferredTempo: 'methodical',
    doctrineTags: ['强硬抵抗', '弹道导弹反击', '消耗战', '非对称封锁', '无人机饱和'],
  },
]

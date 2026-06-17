/**
 * 中途岛海战 1942 — commanders.json 数据。
 *
 * 史实指挥官（查证自维基/百科，人格数值按重写计划「人格数值基底」设计）：
 *
 * 美国：
 * - 尼米兹 Nimitz：太平洋舰队总司令，冷静算计、情报至上，授权斯普鲁恩斯果断出击。
 *   → aggression 高、obedience 高、tempo=methodical（精算后设伏）。
 *
 * 日本：
 * - 山本五十六 Yamamoto：联合舰队司令，赌徒直觉、大胆进攻，策划中途岛决战。
 *   → aggression 中高、obedience 中、tempo=rapid（大胆机动）。
 *
 * @module data/midway-1942/commanders
 */

import type { CampaignCommander } from '@/types'

/** 中途岛海战指挥官人格列表 */
export const midwayCommanders: CampaignCommander[] = [
  // === 美国 ===
  {
    id: 'nimitz',
    name: '切斯特·尼米兹 (Chester W. Nimitz)',
    rank: '美国太平洋舰队总司令（海军上将）',
    factionId: 'usa',
    personality:
      '冷静算计、情报至上的战略大师。破译 JN-25 密码后掌握日军中途岛作战全盘计划，' +
      '果断把仅有的 3 艘航母部署到设伏阵位（"情报是力量倍增器"）。授权前线指挥官斯普鲁恩斯' +
      '临机决断，不微观干预。深信"以少胜多"靠的是情报与时机，而非兵力堆砌。',
    // 冷静算计 + 果断设伏，aggression 高
    aggression: 0.8,
    // 服从度高（服从金恩/总统战略框架，授权前线）
    obedience: 0.9,
    preferredTempo: 'methodical',
    doctrineTags: ['情报至上', '航母决战', '俯冲轰炸', '设伏反击', '以少胜多'],
  },
  // === 日本 ===
  {
    id: 'yamamoto',
    name: '山本五十六 (Isoroku Yamamoto)',
    rank: '日本联合舰队司令长官（海军大将）',
    factionId: 'japan',
    personality:
      '赌徒直觉、大胆进攻的海军名将。策划中途岛作战，企图攻占中途岛引诱美军航母残部决战，' +
      '一举歼灭太平洋舰队。自信于兵力优势（4 艘主力航母 vs 美军 3 艘），却未料 JN-25 密码已破。' +
      '崇尚"舰队决战"学说，主张以航母机动部队主动出击、一锤定音。' +
      '（史实曾反对对美开战，但既开战则倾力求胜。）',
    // 大胆进攻 + 赌徒直觉，aggression 中高
    aggression: 0.7,
    // obedience 中（对军令部战略框架负责，但战术自主性强）
    obedience: 0.6,
    preferredTempo: 'rapid',
    doctrineTags: ['航母机动', '决战至上', '兵力碾压', '赌徒直觉', '大胆进攻'],
  },
]

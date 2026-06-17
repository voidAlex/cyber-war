/**
 * 俄乌冲突 2022 — commanders.json 数据。
 *
 * 史实指挥官（查证自维基/百科/新闻，人格数值按重写计划「人格数值基底」设计）：
 *
 * 乌克兰：
 * - 泽连斯基 Zelensky：战时总统，灵活抵抗 + 争取国际支持，基辅坚守不退。
 *   → aggression 中高、obedience 高（民选领袖凝聚意志）、tempo=rapid（灵活机动反击）。
 *
 * 俄罗斯：
 * - 普京 Putin：战略耐心 + 重型火力，企图速战速决后转入消耗。
 *   → aggression 中、obedience 低（独断专行、不纳前线异议）、tempo=methodical。
 *
 * @module data/ukraine-2022/commanders
 */

import type { CampaignCommander } from '@/types'

/** 俄乌冲突指挥官人格列表 */
export const ukraineCommanders: CampaignCommander[] = [
  // === 乌克兰 ===
  {
    id: 'zelensky',
    name: '弗拉基米尔·泽连斯基 (Volodymyr Zelensky)',
    rank: '乌克兰总统（战时最高统帅）',
    factionId: 'ukraine',
    personality:
      '战时总统，灵活抵抗的战略家。开战之初拒绝撤离基辅（"我需要弹药，不是顺风车"），' +
      '以个人意志凝聚全国抗战决心。善用国际舆论争取西方军援（标枪/NLAW/HIMARS），' +
      '把俄军拖入持久消耗。主张机动防御 + 无人机非对称打击，不与俄军重型装甲正面硬拼。',
    // 灵活抵抗 + 反击，aggression 中高
    aggression: 0.7,
    // 民选领袖凝聚意志，服从度高（服从国家抗战大局）
    obedience: 0.9,
    preferredTempo: 'rapid',
    doctrineTags: ['灵活抵抗', '城市防御', '西方军援', '无人机侦察', '争取国际支持'],
  },
  // === 俄罗斯 ===
  {
    id: 'putin',
    name: '弗拉基米尔·普京 (Vladimir Putin)',
    rank: '俄罗斯总统（战时最高统帅）',
    factionId: 'russia',
    personality:
      '战略耐心的强人领袖。以"特别军事行动"之名全面入侵，企图速战速决夺取基辅更换政权。' +
      '崇尚重型装甲 + 远程炮兵的火力优势，相信俄军可在数日内碾压乌军。' +
      '独断专行、不纳前线将领异议（开战情报误判、兵力分散），基辅攻势受挫后转入顿巴斯消耗战。' +
      '对战争节奏控制欲极强，微观干预前线指挥。',
    // 重型火力 + 消耗，aggression 中
    aggression: 0.5,
    // 独断专行、不纳谏，服从度低（无人可抗命，但自身刚愎）
    obedience: 0.3,
    preferredTempo: 'methodical',
    doctrineTags: ['重型装甲', '远程炮兵', '兵力碾压', '战略耐心', '消耗战'],
  },
]

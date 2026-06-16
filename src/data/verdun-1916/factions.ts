/**
 * 凡尔登战役 1916 — factions.json 数据。
 *
 * 史实（查证自维基/百科）：
 * - 法国（守）：蓝，依托要塞与"神圣之路"后勤苦撑。
 * - 德国（攻）：灰，消耗战略，重炮轰击东岸。
 * - 双方敌对（互为唯一交战方，无第三方阵营）。
 *
 * @module data/verdun-1916/factions
 */

import type { CampaignFaction } from '@/types'

/** 凡尔登阵营列表 */
export const verdunFactions: CampaignFaction[] = [
  {
    id: 'france',
    name: '法兰西第三共和国 (France)',
    color: '#2563EB', // 法军蓝
    side: 'player',
    commanderId: 'petain',
    theaterCommanderIds: ['nivelle'],
    supply: {
      // 开局物资尚足（"神圣之路"后勤轮换维持补给）
      supplies: 70,
      ammunition: 75,
      // 一战步兵为主，燃料非关键，给中等值
      fuel: 50,
    },
    // 法国对外信任度：仅对德国敌对（5），无盟友
    trust: { germany: 5 },
    // 第 5 批：法-德定性关系——交战状态（凡尔登战役双方正在作战）
    relations: { germany: 'at_war' },
    doctrineTags: ['防御战', '要塞据守', '消耗持久', '后勤轮换'],
    description:
      '法军依托凡尔登要塞群与默兹河西岸组织纵深防御，贝当以"神圣之路"（Bar-le-Duc 公路）' +
      '轮换前线部队维持士气与补给，坚守不退。',
  },
  {
    id: 'germany',
    name: '德意志帝国 (German Empire)',
    color: '#6B7280', // 德军灰
    side: 'enemy',
    commanderId: 'falkenhayn',
    theaterCommanderIds: ['crown-prince'],
    supply: {
      // 德军重炮消耗大，开局物资充足
      supplies: 80,
      ammunition: 85,
      fuel: 50,
    },
    trust: { france: 5 },
    // 第 5 批：德-法定性关系——交战状态
    relations: { france: 'at_war' },
    doctrineTags: ['消耗战略', '重炮压制', '消耗战', '要塞攻坚'],
    description:
      '德军在法金汉消耗战略下，以空前规模重炮轰击默兹河东岸法军阵地，' +
      '企图"让法国人流尽鲜血"，以最小代价迫使法国崩溃。皇太子指挥第五集团军主攻。',
  },
]

/**
 * 凡尔登战役 1916 — factions.json 数据。
 *
 * 史实（查证自维基/百科）：
 * - 法国（守）：蓝，依托要塞与"神圣之路"后勤苦撑。
 * - 德国（攻）：灰，消耗战略，重炮轰击东岸。
 * - 英国（第 3 批新增盟友）：索姆河方向牵制德军，独立行动。
 *
 * 第 3 批多阵营：加英国为法方盟友（side='ally'），独立行动（索姆河攻势分散德军）。
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
    // 法国对外信任度：对德国敌对（5），对英国盟友高（85）
    trust: { germany: 5, britain: 85 },
    // 第 5 批 + 第 3 批：法-德交战，法-英结盟
    relations: { germany: 'at_war', britain: 'allied' },
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
    trust: { france: 5, britain: 5 },
    // 第 5 批 + 第 3 批：德-法交战，德-英交战（一战西线同盟国 vs 协约国）
    relations: { france: 'at_war', britain: 'at_war' },
    doctrineTags: ['消耗战略', '重炮压制', '消耗战', '要塞攻坚'],
    description:
      '德军在法金汉消耗战略下，以空前规模重炮轰击默兹河东岸法军阵地，' +
      '企图"让法国人流尽鲜血"，以最小代价迫使法国崩溃。皇太子指挥第五集团军主攻。',
  },
  // === 第 3 批新增：英国（远征军，法方盟友，索姆河方向独立行动） ===
  // 史实：英国远征军（BEF）在黑格指挥下于 1916/7/1 发动索姆河战役，牵制德军、减轻凡尔登压力。
  // 英国是法方盟友但独立行动（索姆河攻势分散德军兵力），加英方可玩外交+协同。
  {
    id: 'britain',
    name: '大英帝国 (Britain)',
    color: '#374151', // 英军深灰（卡其色代理）
    side: 'ally',
    commanderId: 'haig',
    supply: {
      // 英军物资充足（本土 + 帝国资源）
      supplies: 78,
      ammunition: 80,
      fuel: 50,
    },
    trust: { france: 85, germany: 5 },
    // 第 3 批：英-法结盟（协约国），英-德交战
    relations: { france: 'allied', germany: 'at_war' },
    doctrineTags: ['消耗战', '重炮压制', '索姆河牵制', '骑兵突击', '持续进攻'],
    description:
      '英国远征军（BEF）在黑格指挥下发动索姆河战役（1916/7/1），意在牵制德军、减轻凡尔登压力。' +
      '索姆河攻势虽代价惨重（首日伤亡 5.7 万），但分散了德军兵力，间接缓解凡尔登守军压力。' +
      '英军是法方盟友但独立行动，可玩外交协同（法方可请求英方索姆河攻势配合）。',
  },
]

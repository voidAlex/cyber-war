/**
 * 官渡之战（公元 200 年）— factions.json 数据。
 *
 * 史实（查证自《三国志》《资治通鉴》/百科）：
 * - 曹操（守）：挟天子以令诸侯，定都许都；建安五年官渡据袁绍，以少胜多。蓝。
 * - 袁绍（攻）：四世三公，兼并四州之地（冀青幽并），兵多粮足却优柔寡断。灰。
 * - 双方敌对（互为唯一交战方，无第三方阵营）。
 *
 * @module data/guandu-200/factions
 */

import type { CampaignFaction } from '@/types'

/** 官渡阵营列表 */
export const guanduFactions: CampaignFaction[] = [
  {
    id: 'caocao',
    name: '曹操军 (Cao Cao)',
    color: '#1E40AF', // 曹军蓝
    side: 'player',
    commanderId: 'caocao-lord',
    theaterCommanderIds: ['xiahou-dun'],
    supply: {
      // 曹军兵少粮乏，开局物资紧张（史实"粮少欲退"）
      supplies: 40,
      ammunition: 55,
      // 冷兵器时代无燃料概念，给中等占位值
      fuel: 50,
    },
    // 曹操对外信任度：仅对袁绍敌对（5）
    trust: { yuanshao: 5 },
    // 第 5 批：曹-袁定性关系——交战状态（官渡之战双方正在作战）
    relations: { yuanshao: 'at_war' },
    doctrineTags: ['奇袭机动', '坚壁据守', '知人善任', '以少胜多'],
    description:
      '曹操挟天子以令诸侯，定都许都。建安五年面对袁绍十万大军南下，兵少粮乏，' +
      '凭官渡大营据守不退。善用奇谋、知人善任，采纳许攸之计夜袭乌巢，终以少胜多，' +
      '奠定统一北方之基。',
  },
  {
    id: 'yuanshao',
    name: '袁绍军 (Yuan Shao)',
    color: '#6B7280', // 袁军灰
    side: 'enemy',
    commanderId: 'yuanshao-lord',
    theaterCommanderIds: ['yanliang'],
    supply: {
      // 袁绍兵多粮足，开局物资充足（史实"十万众、粮秣山积"）
      supplies: 85,
      ammunition: 70,
      fuel: 50,
    },
    trust: { caocao: 5 },
    // 第 5 批：袁-曹定性关系——交战状态
    relations: { caocao: 'at_war' },
    doctrineTags: ['兵力碾压', '正面强攻', '优柔寡断', '外宽内忌'],
    description:
      '袁绍四世三公，兼并冀青幽并四州，带甲十万、粮秣山积南下争锋。' +
      '然外宽内忌、优柔寡断，谋士沮授田丰之言不用，淳于琼酒徒守乌巢。' +
      '官渡相持数月不下，乌巢粮仓被焚后军心崩溃，张郃高览投降，仅以身免。',
  },
]

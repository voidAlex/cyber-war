/**
 * 官渡之战（公元 200 年）— factions.json 数据。
 *
 * 史实（查证自《三国志》《资治通鉴》/百科）：
 * - 曹操（守）：挟天子以令诸侯，定都许都；建安五年官渡据袁绍，以少胜多。蓝。
 * - 袁绍（攻）：四世三公，兼并四州之地（冀青幽并），兵多粮足却优柔寡断。灰。
 * - 刘表（第 3 批新增中立第三方）：荆州牧，坐拥荆襄八郡，优柔观望，首鼠两端。
 *
 * 第 3 批多阵营：加刘表为中立第三方（side='neutral'），可被袁绍外交拉拢或被曹操收买。
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
    // 注：战区司令角色由 rules.aiRoles 定义（夏侯惇 ai-xiahou-dun-commander），
    // 此处不重复声明 theaterCommanderIds（其引用必须在 commanders.json 中存在的 id）。
    supply: {
      // 曹军兵少粮乏，开局物资紧张（史实"粮少欲退"）
      supplies: 40,
      ammunition: 55,
      // 冷兵器时代无燃料概念，给中等占位值
      fuel: 50,
    },
    // 曹操对外信任度：对袁绍敌对（5），对刘表中立（50）
    trust: { yuanshao: 5, biaojiao: 50 },
    // 第 5 批 + 第 3 批：曹-袁交战，曹-刘表中立
    relations: { yuanshao: 'at_war', biaojiao: 'neutral' },
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
    // 注：战区司令角色由 rules.aiRoles 定义（颜良 ai-yanliang-commander）。
    supply: {
      // 袁绍兵多粮足，开局物资充足（史实"十万众、粮秣山积"）
      supplies: 85,
      ammunition: 70,
      fuel: 50,
    },
    trust: { caocao: 5, biaojiao: 50 },
    // 第 5 批 + 第 3 批：袁-曹交战，袁-刘表中立
    relations: { caocao: 'at_war', biaojiao: 'neutral' },
    doctrineTags: ['兵力碾压', '正面强攻', '优柔寡断', '外宽内忌'],
    description:
      '袁绍四世三公，兼并冀青幽并四州，带甲十万、粮秣山积南下争锋。' +
      '然外宽内忌、优柔寡断，谋士沮授田丰之言不用，淳于琼酒徒守乌巢。' +
      '官渡相持数月不下，乌巢粮仓被焚后军心崩溃，张郃高览投降，仅以身免。',
  },
  // === 第 3 批新增：刘表（荆州牧，中立第三方） ===
  // 史实：刘表坐拥荆州（荆襄八郡），优柔观望。袁绍曾联络夹击曹操，刘表许诺不发兵。
  // 加为中立第三方，可被外交拉拢/收买，胜利条件=保持中立到结束（不被任何一方攻击）。
  {
    id: 'biaojiao',
    name: '刘表军 (Liu Biao)',
    color: '#7c2d12', // 荆州赭石色
    side: 'neutral',
    commanderId: 'liaobiao-lord',
    supply: {
      // 荆州富庶，物资充足（荆襄八郡钱粮丰足）
      supplies: 80,
      ammunition: 65,
      fuel: 50,
    },
    trust: { caocao: 50, yuanshao: 50 },
    // 第 3 批：刘表对曹/袁均中立（首鼠两端）
    relations: { caocao: 'neutral', yuanshao: 'neutral' },
    doctrineTags: ['保境安民', '优柔观望', '首鼠两端', '中立观望', '富庶自守'],
    description:
      '刘表汉室宗亲，荆州牧，坐拥荆襄八郡富庶之地、带甲十余万。优柔观望、首鼠两端，' +
      '袁绍遣使联络夹击曹操，刘表许诺而不发兵；曹操亦遣使安抚。无争雄之志，唯求保境安民。' +
      '可被袁绍外交拉拢（结盟夹击曹操）或被曹操收买（保持中立），玩家可施加外交影响。',
  },
]

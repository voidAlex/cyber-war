/**
 * 官渡之战（公元 200 年）— commanders.json 数据。
 *
 * 史实指挥官（查证自《三国志》《资治通鉴》/百科，人格数值按重写计划「人格数值基底」设计）：
 *
 * 曹操方：
 * - 曹操：知人善任、善用奇谋。官渡以少胜多，纳许攸之计夜袭乌巢。
 *   → aggression 中高、obedience 满（自身即最高统帅）、tempo=methodical（稳守待机、奇谋制胜）。
 *
 * 袁绍方：
 * - 袁绍：优柔寡断、外宽内忌。兵多粮足却不能用谋士之言，乌巢失粮即溃。
 *   → aggression 低、obedience 低（刚愎自用、不纳谏）、tempo=balanced
 *   （schema 无 'steady'，steady 稳健持久之意映射为 balanced）。
 *
 * @module data/guandu-200/commanders
 */

import type { CampaignCommander } from '@/types'

/** 官渡指挥官人格列表 */
export const guanduCommanders: CampaignCommander[] = [
  // === 曹操方 ===
  {
    id: 'caocao-lord',
    name: '曹操 (Cao Cao)',
    rank: '曹操军最高统帅（司空、车骑将军）',
    factionId: 'caocao',
    personality:
      '知人善任、善用奇谋的一代枭雄。官渡以少敌众，凭坚壁据守耗袁军锐气，' +
      '又能纳许攸、荀攸之谏，亲率精锐夜袭乌巢焚粮。用兵灵活多变，善抓战机，' +
      '不拘一格任用降将（关羽、张郃）。深知"兵不在多在精、将不在勇在谋"。',
    // 中高进攻性（奇袭乌巢、善用奇谋）
    aggression: 0.6,
    // 满服从度（自身即最高统帅，无人可抗命）
    obedience: 1.0,
    preferredTempo: 'methodical',
    doctrineTags: ['奇袭机动', '坚壁据守', '知人善任', '以少胜多'],
  },
  // === 袁绍方 ===
  {
    id: 'yuanshao-lord',
    name: '袁绍 (Yuan Shao)',
    rank: '袁绍军最高统帅（大将军，领冀青幽并四州）',
    factionId: 'yuanshao',
    personality:
      '外宽内忌、优柔寡断的四世三公。坐拥四州十万之众、粮秣山积，却不能用谋士沮授、' +
      '田丰之言；好谋无断、多疑少成，许攸因家事被收治而叛投曹操。' +
      '乌巢粮仓被焚即军心崩溃，张郃高览临阵投降，官渡一败涂地。',
    // 低进攻性（优柔寡断、迟疑不决）
    aggression: 0.3,
    // 低服从度（刚愎自用、不纳谏，谋士之言多不听）
    obedience: 0.4,
    // schema 无 'steady'；袁绍稳健持久却迟疑之意映射为 balanced
    preferredTempo: 'balanced',
    doctrineTags: ['兵力碾压', '正面强攻', '优柔寡断', '外宽内忌'],
  },
  // === 刘表方（第 3 批新增中立第三方） ===
  // 史实：刘表坐拥荆州（南方富庶之地），优柔观望。袁绍曾联络刘表夹击曹操，
  // 但刘表首鼠两端、不助任何一方。曹操平定北方后才南下攻荆州（刘表已病亡）。
  {
    id: 'liaobiao-lord',
    name: '刘表 (Liu Biao)',
    rank: '荆州牧（镇南将军，领荆襄八郡）',
    factionId: 'biaojiao',
    personality:
      '优柔观望的荆州牧。坐拥荆襄八郡富庶之地、带甲十余万，却首鼠两端、不助任何一方。' +
      '袁绍曾遣使联络夹击曹操，刘表许诺而不发兵；曹操亦遣使安抚，刘表两不得罪。' +
      '汉室宗亲，雅重文士（建荆州学宫），但无争雄之志，唯求保境安民。' +
      '可被袁绍外交拉拢（结盟夹击曹操）或被曹操收买（保持中立），玩家可施加外交影响。',
    // 低进攻性（优柔观望，不主动出击）
    aggression: 0.2,
    // 低服从度（首鼠两端，不纳任何一方之命）
    obedience: 0.3,
    // schema 无 'steady'；刘表稳健观望之意映射为 balanced
    preferredTempo: 'balanced',
    doctrineTags: ['保境安民', '优柔观望', '首鼠两端', '中立观望', '富庶自守'],
  },
]

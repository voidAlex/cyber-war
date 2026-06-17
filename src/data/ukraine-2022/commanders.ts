/**
 * 俄乌冲突 2022 — commanders.json 数据。
 *
 * 第 2+3 批角色重构：把"参谋长"角色从政治领袖（泽连斯基/普京）改正为职业军人，
 * 政治领袖降格为外交官角色（aiRoles 内），保留人格记录供外交 tab 用。
 *
 * 乌克兰：
 * - 泽连斯基 Zelensky：战时总统，灵活抵抗 + 争取国际支持。第 2+3 批后为外交官人格锚
 *   （faction.commanderId 改为扎卢日内）。
 *   → aggression 中高、obedience 高、tempo=rapid。
 * - 扎卢日内 Zaluzhnyi：乌军武装部队总司令（2022 战时实际军事指挥者），稳健防御 + 反攻。
 *   → aggression 中、obedience 高、tempo=methodical（组织防御+蓄势反攻）。
 *
 * 俄罗斯：
 * - 普京 Putin：战略耐心 + 重型火力。第 2+3 批后为外交官人格锚。
 *   → aggression 中、obedience 低、tempo=methodical。
 * - 格拉西莫夫 Gerasimov：俄军总参谋长（战时军事指挥体系核心），"格拉西莫夫主义"
 *   混合战争学说提出者。
 *   → aggression 中高、obedience 中（与普京有战略分歧传闻）、tempo=methodical。
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
    rank: '乌克兰总统（战时最高统帅，外交与国际军援主导）',
    factionId: 'ukraine',
    personality:
      '战时总统，灵活抵抗的战略家。开战之初拒绝撤离基辅（"我需要弹药，不是顺风车"），' +
      '以个人意志凝聚全国抗战决心。善用国际舆论争取西方军援（标枪/NLAW/HIMARS），' +
      '把俄军拖入持久消耗。主张机动防御 + 无人机非对称打击，不与俄军重型装甲正面硬拼。' +
      '第 2+3 批后定位为外交/政治领袖（争取国际支持），军事指挥交由扎卢日内总司令。',
    // 灵活抵抗 + 反击，aggression 中高
    aggression: 0.7,
    // 民选领袖凝聚意志，服从度高（服从国家抗战大局）
    obedience: 0.9,
    preferredTempo: 'rapid',
    doctrineTags: ['灵活抵抗', '城市防御', '西方军援', '无人机侦察', '争取国际支持'],
  },
  // === 扎卢日内（乌军武装部队总司令，第 2+3 批角色重构新增） ===
  {
    id: 'zaluzhnyi',
    name: '瓦列里·扎卢日内 (Valerii Zaluzhnyi)',
    rank: '乌克兰武装部队总司令（战时军事最高指挥官）',
    factionId: 'ukraine',
    personality:
      '乌军武装部队总司令，2022 战时实际军事指挥者。出身军人世家，稳健务实，' +
      '善组织纵深防御 + 蓄势反攻。主张下放战术指挥权给前线将领（与苏式集权决裂），' +
      '善用北约化情报/通讯体系实施精确打击。基辅防御战中组织城市防御 + 反装甲伏击，' +
      '秋季反攻收复赫尔松/哈尔科夫东部。与总统在反攻时机/兵力运用上有战术分歧。',
    // 稳健防御 + 蓄势反攻，aggression 中（不冒进，时机成熟才反攻）
    aggression: 0.6,
    // 服从度高（服从总统战略框架，军事专业素养高）
    obedience: 0.8,
    preferredTempo: 'methodical',
    doctrineTags: ['纵深防御', '蓄势反攻', '北约化指挥', '精确打击', '灵活战术'],
  },
  // === 俄罗斯 ===
  {
    id: 'putin',
    name: '弗拉基米尔·普京 (Vladimir Putin)',
    rank: '俄罗斯总统（战时最高统帅，外交与战略主导）',
    factionId: 'russia',
    personality:
      '战略耐心的强人领袖。以"特别军事行动"之名全面入侵，企图速战速决夺取基辅更换政权。' +
      '崇尚重型装甲 + 远程炮兵的火力优势，相信俄军可在数日内碾压乌军。' +
      '独断专行、不纳前线将领异议（开战情报误判、兵力分散），基辅攻势受挫后转入顿巴斯消耗战。' +
      '对战争节奏控制欲极强，微观干预前线指挥。第 2+3 批后定位为战略/外交领袖，' +
      '军事指挥交由格拉西莫夫总参谋长执行。',
    // 重型火力 + 消耗，aggression 中
    aggression: 0.5,
    // 独断专行、不纳谏，服从度低（无人可抗命，但自身刚愎）
    obedience: 0.3,
    preferredTempo: 'methodical',
    doctrineTags: ['重型装甲', '远程炮兵', '兵力碾压', '战略耐心', '消耗战'],
  },
  // === 格拉西莫夫（俄军总参谋长，第 2+3 批角色重构新增） ===
  {
    id: 'gerasimov',
    name: '瓦列里·格拉西莫夫 (Valery Gerasimov)',
    rank: '俄罗斯联邦武装力量总参谋长（战时军事指挥体系核心）',
    factionId: 'russia',
    personality:
      '俄军总参谋长，"格拉西莫夫主义"混合战争学说提出者（常规战 + 非对称 + 信息战 + 经济战融合）。' +
      '战时军事指挥体系核心，统筹多路装甲纵队推进 + 远程火力 + 空天压制。' +
      '推崇苏式大纵深作战但受制于补给线脆弱与兵力分散。微观执行普京战略，' +
      '对前线溃败（基辅撤围/哈尔科夫反攻失利）负有指挥责任。',
    // 重型火力 + 大纵深，aggression 中高（主张火力碾压推进）
    aggression: 0.7,
    // obedience 中（执行普京战略，但军方内部对战略有分歧）
    obedience: 0.5,
    preferredTempo: 'methodical',
    doctrineTags: ['混合战争', '大纵深作战', '远程火力', '空天压制', '消耗战'],
  },
  // === 第 3 批新增：北约秘书长（纯外交阵营的占位指挥官） ===
  // 注：NATO 不直接参战，无军事指挥官。faction.commanderId 必填（validateCampaignConsistency
  // 校验），故用一个占位指挥官承载北约外交人格。实际外交对话走 rules.aiRoles 的 diplomat 角色。
  {
    id: 'nato-secretary-general',
    name: '北约秘书长 (NATO Secretary General)',
    rank: '北大西洋公约组织秘书长（联盟外交与军援协调）',
    factionId: 'nato',
    personality:
      '北约秘书长，协调 30 个成员国的军援/情报/制裁共识。提供武器（标枪/HIMARS）但拒绝直接参战，' +
      '在东欧（波兰/波罗的海）强硬派与西欧（德/法）谨慎派之间寻求平衡。' +
      '不愿在乌克兰设禁飞区（顾忌与俄直接冲突升级），但持续加大军援与制裁力度。',
    aggression: 0.3,
    obedience: 0.6,
    preferredTempo: 'methodical',
    doctrineTags: ['联盟外交', '军援协调', '经济制裁', '有限介入', '联盟共识'],
  },
]

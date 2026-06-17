/**
 * 俄乌冲突 2022 — factions.json 数据。
 *
 * 史实（查证自维基/百科/新闻）：
 * - 乌克兰（守）：蓝黄国旗色取蓝（#0057B7）。灵活抵抗 + 城市防御 + 西方军援（标枪/NLAW/HIMARS）。
 * - 俄罗斯（攻）：灰（#6B7280）。重型装甲（T-72/T-90）+ 远程炮兵（2S19）+ 空中优势（开局）。
 * - 双方敌对（互为唯一交战方，无第三方阵营）。
 *
 * @module data/ukraine-2022/factions
 */

import type { CampaignFaction } from '@/types'

/** 俄乌冲突阵营列表 */
export const ukraineFactions: CampaignFaction[] = [
  {
    id: 'ukraine',
    name: '乌克兰 (Ukraine)',
    color: '#0057B7', // 乌克兰国旗蓝
    side: 'player',
    commanderId: 'zelensky',
    // 注：战区司令角色由 rules.aiRoles 定义（乌军陆军司令 ai-ukr-army-commander）。
    supply: {
      // 乌军开局物资中等（西方军援持续注入）
      supplies: 60,
      ammunition: 65,
      // 现代战争燃料关键，乌军燃料储备尚可
      fuel: 55,
    },
    // 乌克兰对外信任度：仅对俄罗斯敌对（5）
    trust: { russia: 5 },
    // 第 5 批：乌-俄定性关系——交战状态
    relations: { russia: 'at_war' },
    doctrineTags: ['灵活抵抗', '城市防御', '反装甲', '西方军援', '无人机侦察'],
    // T2 第 3 批：乌克兰民心 70（泽连斯基凝聚抗战决心）、国际舆论 65（西方广泛支持/军援）。
    publicWill: 70,
    internationalOpinion: 65,
    description:
      '乌克兰在泽连斯基领导下灵活抵抗俄军全面入侵。依托城市防御（基辅/哈尔科夫/马里乌波尔）' +
      '与西方军援（标枪/NLAW 反坦克、HIMARS 远程火箭、Bayraktar 无人机），挫败俄军基辅速战速决企图，' +
      '战争转入持久消耗。无人机与精确打击成乌军非对称优势。',
  },
  {
    id: 'russia',
    name: '俄罗斯 (Russia)',
    color: '#6B7280', // 俄军灰
    side: 'enemy',
    commanderId: 'putin',
    // 注：战区司令角色由 rules.aiRoles 定义（俄军前线指挥 ai-rus-front-commander）。
    supply: {
      // 俄军开局物资充足（重型装甲/弹药储备庞大）
      supplies: 80,
      ammunition: 85,
      // 俄军装甲部队燃料需求大，开局储备充足但补给线长
      fuel: 70,
    },
    trust: { ukraine: 5 },
    // 第 5 批：俄-乌定性关系——交战状态
    relations: { ukraine: 'at_war' },
    doctrineTags: ['重型装甲', '远程炮兵', '兵力碾压', '空中优势', '消耗战'],
    // T2 第 3 批：俄罗斯民心 50（战争疲劳+制裁压力）、国际舆论 25（西方孤立/谴责）。
    publicWill: 50,
    internationalOpinion: 25,
    description:
      '俄罗斯以"特别军事行动"之名全面入侵乌克兰。多路装甲纵队（T-72/T-90/BMP）从北、东、南推进，' +
      '配以远程炮兵（2S19 自行榴弹炮）与空中力量，企图速战速决夺取基辅。' +
      '然后勤补给线长且脆弱、战术僵化，基辅攻势受挫后转入顿巴斯持久消耗战。',
  },
]

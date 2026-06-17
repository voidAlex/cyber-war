/**
 * 俄乌冲突 2022 — factions.json 数据。
 *
 * 史实（查证自维基/百科/新闻）：
 * - 乌克兰（守）：蓝黄国旗色取蓝（#0057B7）。灵活抵抗 + 城市防御 + 西方军援（标枪/NLAW/HIMARS）。
 * - 俄罗斯（攻）：灰（#6B7280）。重型装甲（T-72/T-90）+ 远程炮兵（2S19）+ 空中优势（开局）。
 * - 北约（第 3 批新增）：乌方盟友，提供军援/情报/制裁但不直接参战（纯外交/后勤阵营，无军事单位）。
 *
 * 第 2+3 批：commanderId 改为职业军人（扎卢日内/格拉西莫夫）；政治领袖（泽连斯基/普京）
 * 降格为外交官角色（rules.aiRoles 内的 diplomat）。第 3 批加北约为第三方阵营。
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
    // 第 2+3 批：commanderId 改为扎卢日内（乌军武装部队总司令）。
    // 泽连斯基（政治领袖）降格为外交官角色（见 rules.aiRoles ai-zelensky-diplomat）。
    commanderId: 'zaluzhnyi',
    // 注：战区司令角色由 rules.aiRoles 定义（乌军陆军司令 ai-ukr-army-commander）。
    supply: {
      // 乌军开局物资中等（西方军援持续注入）
      supplies: 60,
      ammunition: 65,
      // 现代战争燃料关键，乌军燃料储备尚可
      fuel: 55,
    },
    // 乌克兰对外信任度：对俄罗斯敌对（5），对北约盟友高（85）
    trust: { russia: 5, nato: 85 },
    // 第 5 批 + 第 3 批：乌-俄交战，乌-北约结盟
    relations: { russia: 'at_war', nato: 'allied' },
    doctrineTags: ['灵活抵抗', '城市防御', '反装甲', '西方军援', '无人机侦察'],
    // T2 第 3 批：乌克兰民心 70（泽连斯基凝聚抗战决心）、国际舆论 65（西方广泛支持/军援）。
    publicWill: 70,
    internationalOpinion: 65,
    description:
      '乌克兰在泽连斯基领导下灵活抵抗俄军全面入侵，军事指挥由扎卢日内总司令统筹。' +
      '依托城市防御（基辅/哈尔科夫/马里乌波尔）与西方军援（标枪/NLAW 反坦克、HIMARS 远程火箭、' +
      'Bayraktar 无人机），挫败俄军基辅速战速决企图，战争转入持久消耗。' +
      '无人机与精确打击成乌军非对称优势。',
  },
  {
    id: 'russia',
    name: '俄罗斯 (Russia)',
    color: '#6B7280', // 俄军灰
    side: 'enemy',
    // 第 2+3 批：commanderId 改为格拉西莫夫（俄军总参谋长）。
    // 普京（政治领袖）降格为外交官角色（见 rules.aiRoles ai-putin-diplomat）。
    commanderId: 'gerasimov',
    // 注：战区司令角色由 rules.aiRoles 定义（俄军前线指挥 ai-rus-front-commander）。
    supply: {
      // 俄军开局物资充足（重型装甲/弹药储备庞大）
      supplies: 80,
      ammunition: 85,
      // 俄军装甲部队燃料需求大，开局储备充足但补给线长
      fuel: 70,
    },
    trust: { ukraine: 5, nato: 5 },
    // 第 5 批 + 第 3 批：俄-乌交战，俄-北约敌对（北约制裁/军援乌方）
    relations: { ukraine: 'at_war', nato: 'hostile' },
    doctrineTags: ['重型装甲', '远程炮兵', '兵力碾压', '空中优势', '消耗战'],
    // T2 第 3 批：俄罗斯民心 50（战争疲劳+制裁压力）、国际舆论 25（西方孤立/谴责）。
    publicWill: 50,
    internationalOpinion: 25,
    description:
      '俄罗斯以"特别军事行动"之名全面入侵乌克兰，军事指挥由格拉西莫夫总参谋长执行。' +
      '多路装甲纵队（T-72/T-90/BMP）从北、东、南推进，配以远程炮兵（2S19 自行榴弹炮）与空中力量，' +
      '企图速战速决夺取基辅。然后勤补给线长且脆弱、战术僵化，基辅攻势受挫后转入顿巴斯持久消耗战。',
  },
  // === 第 3 批新增：北约（纯外交/后勤阵营，无军事单位） ===
  // 史实：北约不直接派兵参战，但提供军援（标枪/HIMARS）、情报共享、对俄经济制裁。
  // 作为玩家选乌时的军援来源（reinforcement 事件由北约触发，受 internationalOpinion 影响），
  // 选俄时为经济制裁对手。阵营 side='ally' 但与乌方目标不完全一致（北约不愿直接参战/设禁飞区）。
  {
    id: 'nato',
    name: '北约 (NATO)',
    color: '#1e40af', // 北约蓝
    side: 'ally',
    // 北约无军事指挥官参战，commanderId 复用北约秘书长人格（虚构，仅外交/后勤角色）。
    // 第 3 批：NATO 为纯外交阵营，diplomat 角色（北约秘书长）在 rules.aiRoles 声明；
    // faction.commanderId 必填，复用一个占位指挥官（nato-secretary-general）。
    commanderId: 'nato-secretary-general',
    supply: {
      // 北约不参战但储备庞大（军援输出方）
      supplies: 90,
      ammunition: 85,
      fuel: 80,
    },
    trust: { ukraine: 85, russia: 5 },
    // 第 3 批：北约-乌克兰结盟（军援），北约-俄罗斯敌对（制裁/对峙）
    relations: { ukraine: 'allied', russia: 'hostile' },
    doctrineTags: ['军援输出', '情报共享', '经济制裁', '联盟外交', '有限介入'],
    publicWill: 60,
    internationalOpinion: 80,
    description:
      '北约（NATO）不直接派兵参战，但作为乌克兰的主要军援/情报/外交支持方。' +
      '提供标枪/NLAW/HIMARS/M777 等武器装备、实时情报共享、对俄严厉经济制裁。' +
      '北约内部对直接介入程度有分歧（东欧成员国主张更强硬，西欧顾忌升级），' +
      '不愿在乌克兰设禁飞区或派兵。玩家选乌时北约是军援来源，选俄时为经济制裁对手。',
  },
]

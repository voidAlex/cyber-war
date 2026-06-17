/**
 * 美以伊冲突 2026 — commanders.json 数据。
 *
 * 第 2+3 批角色重构 + 多阵营拆分：
 * - 原"美以联军"（usisrael 单阵营）拆为 usa（美国）+ israel（以色列）+ iran（伊朗）3 方。
 * - 参谋长角色改正为职业军人（非政治领袖）。政治领袖降格为外交官角色（aiRoles 内）。
 *
 * 美国（usa）：
 * - CENTCOM 司令（美军中央司令部）：战区总司令，指挥波斯湾航母/F-35/战斧联合作战。
 *   → aggression 中高、obedience 高、tempo=methodical。
 *
 * 以色列（israel）：
 * - 以色列国防军总参谋长（IDF Chief of Staff）：果断先发制人，主张摧毁伊朗核能力。
 *   → aggression 高、obedience 中高、tempo=rapid。
 * - 内塔尼亚胡（政治领袖，第 2+3 批降格为外交官人格锚）：以色列总理，推动美军参与联合作战。
 *
 * 伊朗（iran）：
 * - IRGC 司令（伊朗革命卫队总司令）：强硬抵抗消耗战，以非对称手段反击。
 *   → aggression 中、obedience 低、tempo=rapid（非对称快速反击）。
 * - 哈梅内伊（政治领袖，第 2+3 批降格为外交官人格锚）：伊朗最高领袖。
 *
 * @module data/iran-2026/commanders
 */

import type { CampaignCommander } from '@/types'

/** 美以伊冲突指挥官人格列表 */
export const iranCommanders: CampaignCommander[] = [
  // === 美国（usa） ===
  {
    id: 'centcom-commander',
    name: '美军中央司令 (CENTCOM Commander)',
    rank: '美军中央司令部司令（战区总司令，上将）',
    factionId: 'usa',
    personality:
      '美军中央司令部（CENTCOM）战区总司令，统筹波斯湾航母战斗群 + F-35 + 战斧巡航导弹联合作战。' +
      '崇尚精确打击 + 隐身突防的"外科手术"，把握战机窗口。受以色列总理政治推动参与联合作战，' +
      '但对升级风险保持警惕（避免陷入中东持久战）。methodical 不冒进，重视情报确认。',
    // 精确打击 + 联合作战，aggression 中高
    aggression: 0.7,
    // obedience 高（服从总统/国防部战略框架）
    obedience: 0.8,
    preferredTempo: 'methodical',
    doctrineTags: ['精确打击', '隐身突防', '海空一体', '联合作战', '战区统筹'],
  },
  // === 以色列（israel） ===
  {
    id: 'idf-chief',
    name: '以色列国防军总参谋长 (IDF Chief of Staff)',
    rank: '以色列国防军总参谋长（战时军事最高指挥官，中将）',
    factionId: 'israel',
    personality:
      '以色列国防军（IDF）总参谋长，果断先发制人的军事指挥者。坚信伊朗核能力是以色列生存的根本威胁，' +
      '主张以 F-35I Adir 隐身突防 + 钻地弹精确打击"斩首"伊朗核设施。决策果断、不犹豫，' +
      '把握战机窗口。执行内塔尼亚胡先发制人战略，敢冒地区升级风险。',
    // 先发制人 + 果断突袭，aggression 高
    aggression: 0.8,
    // obedience 中高（对国内政治框架负责，但战略自主性强）
    obedience: 0.7,
    preferredTempo: 'rapid',
    doctrineTags: ['先发制人', '精确打击', '隐身突防', '斩首核设施', '果断决策'],
  },
  {
    id: 'netanyahu',
    name: '本雅明·内塔尼亚胡 (Benjamin Netanyahu)',
    rank: '以色列总理（外交与战略主导，推动美军参战）',
    factionId: 'israel',
    personality:
      '果断先发制人的鹰派领袖。坚信伊朗核能力是以色列生存的根本威胁，主张以精确打击' +
      '"斩首"伊朗核设施，趁其核突破前摧毁之。对美方有政治影响力，推动美军参与联合作战。' +
      '第 2+3 批后定位为外交/战略领袖（推动美以联军 + 国际斡旋），军事指挥交由 IDF 总参谋长。',
    aggression: 0.8,
    obedience: 0.7,
    preferredTempo: 'rapid',
    doctrineTags: ['先发制人', '精确打击', '隐身突防', '斩首核设施', '果断决策'],
  },
  // === 伊朗（iran） ===
  {
    id: 'irgc-commander',
    name: '伊朗革命卫队总司令 (IRGC Commander)',
    rank: '伊朗伊斯兰革命卫队（IRGC）总司令（战时军事最高指挥官，少将）',
    factionId: 'iran',
    personality:
      '伊朗革命卫队（IRGC）总司令，强硬抵抗消耗战的军事最高指挥者。主张以弹道导弹反击 + ' +
      '革命卫队非对称作战 + 霍尔木兹海峡封锁拖入持久消耗，让美以付出不可承受代价。' +
      '深信"抵抗经济"与消耗战略能瓦解联军政治意志。崇尚以非对称手段（无人机群/导弹快艇 swarm）反击强敌。',
    // 强硬抵抗 + 快速非对称反击，aggression 中（重消耗+快反）
    aggression: 0.6,
    // obedience 低（革命卫队独立性高，对最高领袖负责但战场自主性强）
    obedience: 0.4,
    preferredTempo: 'rapid',
    doctrineTags: ['强硬抵抗', '弹道导弹反击', '消耗战', '非对称封锁', '无人机饱和'],
  },
  {
    id: 'khamenei',
    name: '阿里·哈梅内伊 (Ali Khamenei)',
    rank: '伊朗最高领袖（外交与战略主导，革命卫队最高统帅）',
    factionId: 'iran',
    personality:
      '强硬抵抗消耗战的最高领袖。面对美以先发打击，主张以弹道导弹反击 + 革命卫队非对称作战 + ' +
      '霍尔木兹海峡封锁拖入持久消耗。深信"抵抗经济"与消耗战略能瓦解联军政治意志。' +
      '独断专行、不纳异议，对革命卫队（IRGC）绝对掌控。第 2+3 批后定位为外交/战略领袖，' +
      '军事指挥交由 IRGC 总司令执行。',
    aggression: 0.4,
    obedience: 0.3,
    preferredTempo: 'methodical',
    doctrineTags: ['强硬抵抗', '弹道导弹反击', '消耗战', '非对称封锁', '无人机饱和'],
  },
]

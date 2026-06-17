/**
 * 凡尔登战役 1916 — commanders.json 数据。
 *
 * 史实指挥官（查证自维基/百科，人格数值按重写计划「人格数值基底」设计）：
 *
 * 法国：
 * - 贝当 Pétain：2/25 起任前线指挥，稳健防御 + 后勤轮换（"神圣之路"）。
 *   → obedience 高、aggression 低、tempo=methodical。
 * - 尼韦勒 Nivelle：5/1 接替贝当，反攻激进。
 *   → aggression 高、obedience 中、tempo=rapid。
 *
 * 德国：
 * - 法金汉 Falkenhayn：消耗战略"让法国人流尽鲜血"，methodical、aggression 中。
 *   → obedience 中、aggression 中、tempo=methodical。
 * - 皇太子 Wilhelm（第五集团军司令）：实际指挥东岸主攻，较激进。
 *   → aggression 中高、obedience 高（服从法金汉战略）、tempo=balanced。
 *
 * @module data/verdun-1916/commanders
 */

import type { CampaignCommander } from '@/types'

/** 凡尔登指挥官人格列表 */
export const verdunCommanders: CampaignCommander[] = [
  // === 法国 ===
  {
    id: 'petain',
    name: '菲利普·贝当 (Philippe Pétain)',
    rank: '法国凡尔登前线总指挥（后升任法军总司令）',
    factionId: 'france',
    personality:
      '稳健务实的防御大师。信奉"火力制胜"与轮换休整，拒绝鲁莽反攻。' +
      '深谙消耗战之道：以"神圣之路"后勤轮换维持前线战力，宁可让出无关紧要的地形也要保全有生力量。' +
      '对上级（霞飞）服从度高，但在战术执行上坚持己见。',
    // 稳健防御，aggression 低
    aggression: 0.25,
    // 服从度高（服从霞飞的战略框架）
    obedience: 0.8,
    preferredTempo: 'methodical',
    doctrineTags: ['防御战', '要塞据守', '消耗持久', '后勤轮换', '火力制胜'],
  },
  {
    id: 'nivelle',
    name: '罗贝尔·尼韦勒 (Robert Nivelle)',
    rank: '法国第二集团军司令（5/1 接替贝当任凡尔登前线指挥）',
    factionId: 'france',
    personality:
      '自信张扬的进攻派。相信"重炮开路、步兵突进"可在短时间内突破德军防线，' +
      '主张激进反攻收复失地。敢于冒险，对上级承诺过多，往往高估己方能力（史实在 1917 埃纳河攻势中因此翻车）。' +
      '在凡尔登前期靠激进反攻（如杜奥蒙收复战）提振士气，但也付出惨重代价。',
    // 反攻激进，aggression 高
    aggression: 0.8,
    // obedience 中（敢越级上报、坚持进攻主张）
    obedience: 0.5,
    preferredTempo: 'rapid',
    doctrineTags: ['进攻反攻', '重炮压制', '突破穿插', '冒险突进'],
  },
  // === 德国 ===
  {
    id: 'falkenhayn',
    name: '埃里希·冯·法金汉 (Erich von Falkenhayn)',
    rank: '德军总参谋长（凡尔登攻势策划者）',
    factionId: 'germany',
    personality:
      '冷静精算的战略家。凡尔登攻势的核心策划者，提出"让法国人流尽鲜血"的消耗战略——' +
      '不求速胜占领凡尔登，而是以重炮在要塞前制造法军无法承受的伤亡交换比。' +
      '坚信消耗战能拖垮法国意志。methodical 而不冒进，但对战场僵局的判断偶有偏差。',
    // 消耗战略，aggression 中（不追求速胜）
    aggression: 0.5,
    // obedience 中（对德皇与军方高层负责，但战略自主性强）
    obedience: 0.55,
    preferredTempo: 'methodical',
    doctrineTags: ['消耗战略', '重炮压制', '消耗战', '要塞攻坚', '战略精算'],
  },
  {
    id: 'crown-prince',
    name: '威廉皇太子 (Crown Prince Wilhelm)',
    rank: '德国第五集团军司令（东岸主攻实际指挥）',
    factionId: 'germany',
    personality:
      '年轻而尚武的普鲁士军人。实际指挥第五集团军在默兹河东岸主攻，' +
      '主张趁炮击效果发起步兵冲锋扩大战果，较其上司法金汉更为激进。' +
      '服从法金汉的消耗战略大框架，但在战术层面屡屡请求加大进攻力度。' +
      '对杜奥蒙堡的攻占（2/25）起到关键推动作用。',
    // 较法金汉激进，aggression 中高
    aggression: 0.7,
    // obedience 高（服从法金汉战略框架）
    obedience: 0.75,
    preferredTempo: 'balanced',
    doctrineTags: ['消耗战略', '要塞攻坚', '步兵冲锋', '进攻扩大战果'],
  },
  // === 第 3 批新增：英国（远征军） ===
  // 史实：道格拉斯·黑格（Douglas Haig）1915-1918 任英国远征军（BEF）总司令。
  // 凡尔登战役期间（1916），黑格正筹备并发动索姆河战役（7/1），意在牵制德军、减轻凡尔登压力。
  // 黑格信奉消耗战 + 骑兵突击，索姆河首日伤亡 5.7 万创英军单日纪录，但确实分散了德军兵力。
  {
    id: 'haig',
    name: '道格拉斯·黑格 (Douglas Haig)',
    rank: '英国远征军（BEF）总司令（陆军元帅）',
    factionId: 'britain',
    personality:
      '英国远征军总司令，消耗战信奉者。坚信"重炮开路 + 步兵持续冲锋"能压垮德军防线。' +
      '凡尔登战役期间发动索姆河战役（1916/7/1），意在牵制德军、减轻凡尔登压力。' +
      '索姆河首日伤亡 5.7 万创英军单日纪录，但确实分散了德军兵力，间接缓解凡尔登守军压力。' +
      '固执、重视传统骑兵突击学说，对新技术（坦克/飞机）态度保守但逐步接受。',
    // 消耗战 + 持续进攻，aggression 高（信奉进攻消耗敌军）
    aggression: 0.8,
    // obedience 中（对伦敦战略框架负责，但战术自主性强，常坚持己见）
    obedience: 0.5,
    preferredTempo: 'methodical',
    doctrineTags: ['消耗战', '重炮压制', '索姆河牵制', '骑兵突击', '持续进攻'],
  },
]

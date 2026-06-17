/**
 * 俄乌冲突 2022 — manifest.json 数据。
 *
 * 史实（查证自维基/百科/新闻报道）：
 * - 时间：2022/02/24 俄罗斯对乌克兰发起"特别军事行动"，全面入侵。
 * - 双方：乌克兰（守，灵活抵抗 + 西方军援）vs 俄罗斯（攻，重型装甲 + 远程火力）。
 * - scenarioId=ukraine-2022，固定 seed，玩家可选乌（守）/俄（攻）。
 *
 * @module data/ukraine-2022/manifest
 */

import type { CampaignManifest } from '@/types'
import { CAMPAIGN_SCHEMA_VERSION } from '@/types'

/** 俄乌冲突战役包清单 */
export const ukraineManifest: CampaignManifest = {
  scenarioId: 'ukraine-2022',
  displayName: '俄乌冲突 2022',
  // 固定种子（确定性随机基底：scenarioSeed:turn:sequence）
  scenarioSeed: 'ukraine-2022:20220224',
  schemaVersion: CAMPAIGN_SCHEMA_VERSION,
  // 玩家可选乌克兰（守）/俄罗斯（攻）/北约（第 3 批新增，纯外交军援阵营）。
  playerFactionIds: ['ukraine', 'russia', 'nato'],
  description:
    '2022年2月24日，俄罗斯对乌克兰发动全面入侵。俄军多路装甲纵队从北、东、南推进，' +
    '企图速战速决夺取基辅。乌军在泽连斯基领导下灵活抵抗，依托城市防御与西方军援（标枪/NLAW/HIMARS）' +
    '挫败俄军基辅攻势，战争转入持久消耗。',
  // 开局：2022年2月24日（俄军全面入侵之日）
  startInGameDate: '2022-02-24',
  // 每回合对应局内 3 天（战争节奏较快，3 天/回合缩放为 30 回合≈90 天）
  daysPerTurn: 3,
  // 30 回合上限（≈90 天，覆盖基辅攻势受挫至战线稳定阶段）
  maxTurns: 30,
}

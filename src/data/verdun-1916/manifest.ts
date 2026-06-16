/**
 * 凡尔登战役 1916 — manifest.json 数据。
 *
 * 史实（查证自维基/百科）：
 * - 时间：1916/02/21 – 12/19，一战西线最长最惨烈战役（"凡尔登绞肉机"）。
 * - 双方：德国（攻）vs 法国（守），消耗战，双方共约 71 万伤亡。
 * - scenarioId=verdun-1916，固定 seed，玩家可选法（守）/德（攻）。
 *
 * @module data/verdun-1916/manifest
 */

import type { CampaignManifest } from '@/types'
import { CAMPAIGN_SCHEMA_VERSION } from '@/types'

/** 凡尔登战役包清单 */
export const verdunManifest: CampaignManifest = {
  scenarioId: 'verdun-1916',
  displayName: '凡尔登战役 1916',
  // 固定种子（确定性随机基底：scenarioSeed:turn:sequence）
  // 选用 19162102（1916-02-21 反写）作为可读的固定 seed
  scenarioSeed: 'verdun-1916:19160221',
  schemaVersion: CAMPAIGN_SCHEMA_VERSION,
  // 玩家可选法国（守）或德国（攻）
  playerFactionIds: ['france', 'germany'],
  description:
    '1916年2月21日，德军在法金汉"让法国人流尽鲜血"的消耗战略下发动凡尔登攻势。' +
    '默兹河两岸的堑壕、要塞与炮火交织成"凡尔登绞肉机"。法军在贝当"神圣之路"后勤轮换下苦撑，' +
    '10月反攻收复杜奥蒙堡。双方共约71万伤亡，一战西线最长最惨烈之役。',
  // 开局：1916年2月21日（德军发动攻势之日）
  startInGameDate: '1916-02-21',
  // 第 5 批：每回合对应局内天数（默认 1）。Header 显示「D+{turn}」按 1 天/回合推进；
  // 凡尔登剧本战役实际跨 10 个月，但 UI 时间推进粒度按 1 天/回合（与 maxTurns=30 缩放解耦）。
  daysPerTurn: 1,
  // 战役跨10个月，按剧本缩放为 30 回合（每回合≈10天）
  maxTurns: 30,
}

/**
 * 官渡之战（公元 200 年）— manifest.json 数据。
 *
 * 史实（查证自《三国志》《资治通鉴》/百科）：
 * - 时间：建安五年（公元 200 年）二月白马之役起，至十月乌巢劫粮、官渡决战，袁绍大军崩溃。
 *   剧本起始取建安五年十月（200-10）乌巢劫粮前夜，缩放为 30 回合。
 * - 双方：曹操（守，约 2-4 万）vs 袁绍（攻，约 10 万），以少胜多的经典战例。
 * - scenarioId=guandu-200，固定 seed，玩家可选曹（守）/袁（攻）。
 *
 * @module data/guandu-200/manifest
 */

import type { CampaignManifest } from '@/types'
import { CAMPAIGN_SCHEMA_VERSION } from '@/types'

/** 官渡之战战役包清单 */
export const guanduManifest: CampaignManifest = {
  scenarioId: 'guandu-200',
  displayName: '官渡之战（公元200年）',
  // 固定种子（确定性随机基底：scenarioSeed:turn:sequence）
  // 选用 'guandu:200' 作为可读固定 seed
  scenarioSeed: 'guandu:200',
  schemaVersion: CAMPAIGN_SCHEMA_VERSION,
  // 玩家可选曹操（守）或袁绍（攻）
  playerFactionIds: ['caocao', 'yuanshao'],
  description:
    '建安五年（公元200年），袁绍率精兵十万南下，与曹操会战于官渡。曹军兵少粮乏，' +
    '凭官渡大营据守不退。相持数月，曹操采纳许攸之计，亲率精锐夜袭乌巢粮仓，' +
    '焚毁袁军辎重，袁军军心溃散，张郃高览投降，袁绍仅以身免。此役奠定曹操统一北方之基。',
  // 开局：公元 200 年 10 月（乌巢劫粮前夜，决战前夕）
  startInGameDate: '200-10-01',
  // 每回合对应局内 1 天（Header 显示「D+{turn}」按 1 天/回合推进）
  daysPerTurn: 1,
  // 决战缩放为 30 回合上限（与 victory.maxTurns 互为冗余校验）
  maxTurns: 30,
}

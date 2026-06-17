/**
 * 美以伊冲突 2026 — manifest.json 数据。
 *
 * 背景设定（虚构近未来剧本，2026 年）：
 * - 时间：2026/02/28 假想冲突爆发。美以联军对伊朗核设施实施先发制人打击，伊朗以弹道导弹/
 *   无人机/革命卫队反击，霍尔木兹海峡封锁危机。
 * - 双方：美以联军（攻，海空精确打击 + 特种作战）vs 伊朗（守/反击，弹道导弹 + 革命卫队 +
 *   无人机群 + 导弹快艇）。
 * - scenarioId=iran-2026，固定 seed，玩家可选美以（攻）/伊朗（守反击）。
 *
 * @module data/iran-2026/manifest
 */

import type { CampaignManifest } from '@/types'
import { CAMPAIGN_SCHEMA_VERSION } from '@/types'

/** 美以伊冲突战役包清单 */
export const iranManifest: CampaignManifest = {
  scenarioId: 'iran-2026',
  displayName: '美以伊冲突 2026',
  // 固定种子（确定性随机基底：scenarioSeed:turn:sequence）
  scenarioSeed: 'iran-2026:20260228',
  schemaVersion: CAMPAIGN_SCHEMA_VERSION,
  // 玩家可选美以联军（攻）或伊朗（守反击）
  playerFactionIds: ['usisrael', 'iran'],
  description:
    '2026年2月，美以联军对伊朗核设施（纳坦兹/福特罗）实施先发制人精确打击，企图摧毁伊朗核能力。' +
    '伊朗以弹道导弹（Sejjil/Emad）反击以色列与美军波斯湾舰队，革命卫队（IRGC）导弹快艇封锁' +
    '霍尔木兹海峡，Shahed-136 无人机群饱和攻击。地区冲突升级，全球能源危机风险骤升。',
  // 开局：2026年2月28日（假想冲突爆发之日）
  startInGameDate: '2026-02-28',
  // 每回合对应局内 2 天（精确打击 + 反击节奏，2 天/回合缩放为 15 回合≈30 天）
  daysPerTurn: 2,
  // 15 回合上限（≈30 天，覆盖先发打击→伊朗反击→核设施决战→外交斡旋阶段）
  maxTurns: 15,
}

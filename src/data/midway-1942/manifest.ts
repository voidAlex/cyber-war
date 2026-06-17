/**
 * 中途岛海战 1942 — manifest.json 数据。
 *
 * 史实（查证自维基/百科）：
 * - 时间：1942/06/04–06/07，太平洋战争转折点。日军企图攻占中途岛引诱美军航母决战，
 *   美军凭破译 JN-25 密码的情报优势，以少胜多击沉日军四艘主力航母（赤城/加贺/苍龙/飞龙）。
 * - 双方：美国（守，3 艘航母）vs 日本（攻，4 艘航母 + 巨大舰队优势）。
 * - scenarioId=midway-1942，固定 seed，玩家可选美（守）/日（攻）。
 *
 * @module data/midway-1942/manifest
 */

import type { CampaignManifest } from '@/types'
import { CAMPAIGN_SCHEMA_VERSION } from '@/types'

/** 中途岛海战战役包清单 */
export const midwayManifest: CampaignManifest = {
  scenarioId: 'midway-1942',
  displayName: '中途岛海战 1942',
  // 固定种子（确定性随机基底：scenarioSeed:turn:sequence）
  scenarioSeed: 'midway-1942:19420604',
  schemaVersion: CAMPAIGN_SCHEMA_VERSION,
  // 玩家可选美国（守）或日本（攻）
  playerFactionIds: ['usa', 'japan'],
  description:
    '1942年6月4日，日军山本五十六企图攻占中途岛引诱美军太平洋舰队残部决战，' +
    '以航母机动部队（赤城/加贺/苍龙/飞龙）为核心。美军尼米兹凭破译 JN-25 密码的情报优势' +
    '设伏，斯普鲁恩斯指挥企业/约克城/大黄蜂三艘航母，趁南云换弹危机发动 SBD 俯冲轰炸机突袭，' +
    '一日内击沉日军四艘主力航母，太平洋战争攻守易势。',
  // 开局：1942年6月4日（海战爆发之日）
  startInGameDate: '1942-06-04',
  // 每回合对应局内 1 天（海战节奏以天计）
  daysPerTurn: 1,
  // 10 回合上限（短战役，海战核心决战约 3-4 天，缩放为 10 回合覆盖侦察/换弹/决战/追击）
  maxTurns: 10,
}

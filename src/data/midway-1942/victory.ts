/**
 * 中途岛海战 1942 — victory.json 数据（胜负条件）。
 *
 * 史实胜负（查证自维基/百科）：
 * - 美国目标：重创日军航母机动部队（击沉≥3 艘主力航母，即日军战损超 40%——日本舰队以航母为核心，
 *   战损阈值按全阵营 strength 损失比例代理）。美军凭情报优势以少胜多。
 * - 日本目标：攻占中途岛（夺取前沿基地，引诱并歼灭美军航母残部）。
 *
 * 注：casualty 判定按阵营累计 strength 战损比例（checkVictory 汇总敌方阵营承受战损）。
 * 日军舰队以 4 艘航母为核心，战损 40% 约等同于 3 艘航母沉没（核心战力损失）。
 *
 * @module data/midway-1942/victory
 */

import type { CampaignVictory } from '@/types'

/** 中途岛海战胜负条件 */
export const midwayVictory: CampaignVictory = {
  // 10 回合上限（短战役，覆盖侦察/换弹/决战/追击）
  maxTurns: 10,
  conditions: [
    // === 美国（守）胜利条件 ===
    {
      id: 'usa-decimate-japan-carriers',
      factionId: 'usa',
      type: 'casualty',
      description:
        '重创日军航母机动部队：日军战损超过 40%（约等同于击沉 3 艘主力航母，太平洋战争转折）',
      targetFactionId: 'japan',
      casualtyThreshold: 0.4,
    },
    {
      id: 'usa-hold-midway',
      factionId: 'usa',
      type: 'objective',
      description:
        '美军确保中途岛不失（守住前沿机场/基地，挫败日军攻占企图）',
      nodeId: 'midway',
    },
    // === 日本（攻）胜利条件 ===
    {
      id: 'japan-capture-midway',
      factionId: 'japan',
      type: 'objective',
      description:
        '日军攻占中途岛（夺取前沿基地，引诱并歼灭美军航母残部，实现"舰队决战"战略）',
      nodeId: 'midway',
    },
    {
      id: 'japan-attrition-usa',
      factionId: 'japan',
      type: 'casualty',
      description:
        '消耗美军：美军战损超过 50%（以 4 航母兵力优势歼灭美军仅 3 艘航母）',
      targetFactionId: 'usa',
      casualtyThreshold: 0.5,
    },
  ],
}

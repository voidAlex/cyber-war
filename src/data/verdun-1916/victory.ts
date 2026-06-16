/**
 * 凡尔登战役 1916 — victory.json 数据（胜负条件）。
 *
 * 史实胜负（查证自维基/百科）：
 * - 德国目标：占领凡尔登核心要塞（杜奥蒙/沃/苏维尔）或凡尔登城；
 *   或法军战损超阈值（消耗目标——"让法国人流尽鲜血"）。
 * - 法国目标：守至回合上限（史实法军苦撑至 12 月，12/19 战役以法军反攻收复失地告终）；
 *   或反攻收复杜奥蒙堡（史实 10/24 法军收复杜奥蒙）。
 *
 * @module data/verdun-1916/victory
 */

import type { CampaignVictory } from '@/types'

/** 凡尔登胜负条件 */
export const verdunVictory: CampaignVictory = {
  // 30 回合上限（≈10 个月战役缩放）
  maxTurns: 30,
  conditions: [
    // === 德国（攻）胜利条件 ===
    {
      id: 'germany-capture-verdun',
      factionId: 'germany',
      type: 'objective',
      description:
        '德国占领凡尔登城（突破法军最后防线，迫使法国战略崩溃）',
      nodeId: 'verdun-city',
    },
    {
      id: 'germany-capture-douaumont',
      factionId: 'germany',
      type: 'objective',
      description:
        '德国攻占并控制杜奥蒙堡（东岸要塞群核心，史实 2/25 陷落）',
      nodeId: 'fort-douaumont',
    },
    {
      id: 'germany-attrition-france',
      factionId: 'germany',
      type: 'casualty',
      description:
        '消耗战略达成：法军战损超过 50%（"让法国人流尽鲜血"）',
      targetFactionId: 'france',
      casualtyThreshold: 0.5,
    },
    // === 法国（守）胜利条件 ===
    {
      id: 'france-hold-to-end',
      factionId: 'france',
      type: 'turn_limit',
      description:
        '法军坚守至战役回合上限（30 回合，史实法军苦撑至 12/19 战役结束）',
    },
    {
      id: 'france-recapture-douaumont',
      factionId: 'france',
      type: 'objective',
      description:
        '法军反攻收复杜奥蒙堡（史实 10/24 法军反攻夺回，标志消耗战转折）',
      nodeId: 'fort-douaumont',
    },
    {
      id: 'france-attrition-germany',
      factionId: 'france',
      type: 'casualty',
      description:
        '德军战损超过 45%（反攻消耗德军，使其攻势难以为继）',
      targetFactionId: 'germany',
      casualtyThreshold: 0.45,
    },
    // === 第 5 批：积分制胜利（占节点+100/歼敌+10/回合-5，试算阈值 800） ===
    {
      id: 'france-score-victory',
      factionId: 'france',
      type: 'score',
      description:
        '法军累计积分达 800（占节点 +100/歼敌 +10/回合 -5），标志战役主导权确立',
      scoreThreshold: 800,
    },
    // === 第 5 批：累计歼敌目标（法军累计造成德军 6000 人伤亡即胜） ===
    {
      id: 'france-cumulative-casualties',
      factionId: 'france',
      type: 'cumulative',
      description:
        '法军累计造成德军 6000 人伤亡（消耗战略反制：让德国人流尽鲜血）',
      cumulativeTarget: 6000,
      cumulativeMetric: 'casualties_inflicted',
    },
    // === 第 5 批：德军积分制胜利（同等积分体系，阈值 1000 体现进攻方需更大战果） ===
    {
      id: 'germany-score-victory',
      factionId: 'germany',
      type: 'score',
      description:
        '德军累计积分达 1000（占节点 +100/歼敌 +10/回合 -5），标志消耗战略达成',
      scoreThreshold: 1000,
    },
  ],
}

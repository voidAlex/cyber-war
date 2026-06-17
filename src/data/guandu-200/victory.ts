/**
 * 官渡之战（公元 200 年）— victory.json 数据（胜负条件）。
 *
 * 史实胜负（查证自《三国志》《资治通鉴》/百科）：
 * - 曹操目标：坚守官渡至回合上限（史实相持数月后反攻获胜）；或重创袁军主力（战损超 70%），
 *   令袁绍仅以身免。
 * - 袁绍目标：攻占官渡大营（突破曹军核心防线，直取许都）；或重创曹军（战损超 70%），
 *   以兵力碾压压垮曹操。
 *
 * @module data/guandu-200/victory
 */

import type { CampaignVictory } from '@/types'

/** 官渡胜负条件 */
export const guanduVictory: CampaignVictory = {
  // 30 回合上限（决战缩放）
  maxTurns: 30,
  conditions: [
    // === 曹操（守）胜利条件 ===
    {
      id: 'caocao-hold-to-end',
      factionId: 'caocao',
      type: 'turn_limit',
      description:
        '曹军坚守官渡至战役回合上限（30 回合，史实相持后反攻获胜）',
    },
    {
      id: 'caocao-attrition-yuanshao',
      factionId: 'caocao',
      type: 'casualty',
      description:
        '重创袁军：袁军战损超过 70%（乌巢焚粮后军心崩溃，张郃高览投降，袁绍仅以身免）',
      targetFactionId: 'yuanshao',
      casualtyThreshold: 0.7,
    },
    // === 袁绍（攻）胜利条件 ===
    {
      id: 'yuanshao-capture-guandu',
      factionId: 'yuanshao',
      type: 'objective',
      description:
        '袁军攻占官渡大营（突破曹军核心防线，十万大军直取许都）',
      nodeId: 'guandu-camp',
    },
    {
      id: 'yuanshao-attrition-caocao',
      factionId: 'yuanshao',
      type: 'casualty',
      description:
        '消耗曹军：曹军战损超过 70%（以十万之众压垮兵少粮乏的曹操）',
      targetFactionId: 'caocao',
      casualtyThreshold: 0.7,
    },
  ],
}

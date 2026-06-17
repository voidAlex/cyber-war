/**
 * 美以伊冲突 2026 — victory.json 数据（胜负条件）。
 *
 * 胜负设定（虚构近未来剧本）：
 * - 美以联军目标：摧毁伊朗核设施（占领/摧毁纳坦兹 + 福特罗，消除伊朗核能力）。
 * - 伊朗目标：击沉美军 1 艘航母（重创美军舰队战力，以 casualty 阈值代理——美军战损超 45%
 *   约等同于 1 艘航母丧失战斗力）；或确保核设施不失（守至回合上限）。
 *
 * 注：casualty 判定按阵营累计 strength 战损比例（checkVictory 汇总敌方阵营承受战损）。
 * 美军以 2 艘航母 + 驱逐舰为核心，战损 45% 约等同于 1 艘航母丧失战斗力 + 舰队承压。
 *
 * @module data/iran-2026/victory
 */

import type { CampaignVictory } from '@/types'

/** 美以伊冲突胜负条件 */
export const iranVictory: CampaignVictory = {
  // 15 回合上限（≈30 天，覆盖先发打击→伊朗反击→核设施决战→外交斡旋阶段）
  maxTurns: 15,
  conditions: [
    // === 美以联军（攻）胜利条件 ===
    {
      id: 'usisrael-destroy-natanz',
      factionId: 'usisrael',
      type: 'objective',
      description:
        '摧毁纳坦兹核设施（精确打击摧毁铀浓缩核心，消除伊朗核能力主轴）',
      nodeId: 'natanz',
    },
    {
      id: 'usisrael-destroy-fordow',
      factionId: 'usisrael',
      type: 'objective',
      description:
        '摧毁福特罗核设施（钻地弹摧毁深埋地下工事，根除伊朗核能力）',
      nodeId: 'fordow',
    },
    // === 伊朗（守反击）胜利条件 ===
    {
      id: 'iran-sink-carrier',
      factionId: 'iran',
      type: 'casualty',
      description:
        '击沉/重创美军 1 艘航母：美军战损超过 45%（弹道导弹命中航母，美军舰队战力重创）',
      targetFactionId: 'usisrael',
      casualtyThreshold: 0.45,
    },
    {
      id: 'iran-defend-nuclear',
      factionId: 'iran',
      type: 'turn_limit',
      description:
        '伊朗坚守核设施至战役回合上限（15 回合，消耗联军政治意志，迫使其停战）',
    },
  ],
}

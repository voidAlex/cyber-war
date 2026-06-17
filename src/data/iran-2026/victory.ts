/**
 * 美以伊冲突 2026 — victory.json 数据（胜负条件）。
 *
 * 第 3 批多阵营拆分：原"美以联军"胜利条件按真实归属拆为 usa + israel 独立条件。
 *
 * 胜负设定（虚构近未来剧本）：
 * - 美国（usa）目标：摧毁核设施（与以色列共担，精确打击主力）。
 * - 以色列（israel）目标：摧毁核设施 + 削弱伊朗弹道导弹（以方更激进，视核能力为生存威胁）。
 * - 伊朗（iran）目标：击沉美军航母 + 封锁霍尔木兹海峡（重创联军舰队 + 全球能源危机）。
 *
 * 注：casualty 判定按阵营累计 strength 战损比例（checkVictory 汇总敌方阵营承受战损）。
 *
 * @module data/iran-2026/victory
 */

import type { CampaignVictory } from '@/types'

/** 美以伊冲突胜负条件 */
export const iranVictory: CampaignVictory = {
  // 15 回合上限（≈30 天，覆盖先发打击→伊朗反击→核设施决战→外交斡旋阶段）
  maxTurns: 15,
  conditions: [
    // === 美国（usa，攻）胜利条件（第 3 批拆分） ===
    {
      id: 'usa-destroy-natanz',
      factionId: 'usa',
      type: 'objective',
      description:
        '美军摧毁纳坦兹核设施（战斧精确打击摧毁铀浓缩核心，消除伊朗核能力主轴）',
      nodeId: 'natanz',
    },
    {
      id: 'usa-destroy-fordow',
      factionId: 'usa',
      type: 'objective',
      description:
        '美军摧毁福特罗核设施（战斧 + F-35 钻地弹摧毁深埋地下工事）',
      nodeId: 'fordow',
    },
    // === 以色列（israel，攻）胜利条件（第 3 批拆分，更激进） ===
    {
      id: 'israel-destroy-nuclear',
      factionId: 'israel',
      type: 'objective',
      description:
        '以色列 F-35I 突防摧毁核设施（纳坦兹或福特罗，根除伊朗核能力，视为以色列生存威胁解除）',
      nodeId: 'natanz',
    },
    {
      id: 'israel-weaken-iran-missiles',
      factionId: 'israel',
      type: 'casualty',
      description:
        '削弱伊朗弹道导弹：伊朗战损超过 60%（F-35 斩首伊朗导弹部队指挥中枢，解除反击能力）',
      targetFactionId: 'iran',
      casualtyThreshold: 0.6,
    },
    // === 伊朗（守反击）胜利条件（第 3 批拆分） ===
    {
      id: 'iran-sink-carrier',
      factionId: 'iran',
      type: 'casualty',
      description:
        '击沉/重创美军 1 艘航母：美军战损超过 45%（弹道导弹命中航母，美军舰队战力重创）',
      targetFactionId: 'usa',
      casualtyThreshold: 0.45,
    },
    {
      id: 'iran-blockade-hormuz',
      factionId: 'iran',
      type: 'turn_limit',
      description:
        '伊朗坚守霍尔木兹封锁至战役回合上限（15 回合，IRGC 快艇+水雷持续封锁，' +
        '全球能源危机迫使美以停战）',
    },
  ],
}

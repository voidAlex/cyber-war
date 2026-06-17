/**
 * 俄乌冲突 2022 — victory.json 数据（胜负条件）。
 *
 * 史实胜负（查证自维基/百科/新闻）：
 * - 乌克兰目标：坚守至回合上限（挫败俄军速战速决企图，战争转入持久）；或收复赫尔松
 *   （史实 2022/11 乌军反攻收复赫尔松市）。
 * - 俄罗斯目标：攻占基辅（推翻泽连斯基政权，更换亲俄政府）；或重创乌军（战损超 60%），
 *   以兵力/火力碾压压垮乌克兰。
 *
 * @module data/ukraine-2022/victory
 */

import type { CampaignVictory } from '@/types'

/** 俄乌冲突胜负条件 */
export const ukraineVictory: CampaignVictory = {
  // 30 回合上限（≈90 天，覆盖基辅攻势受挫至战线稳定阶段）
  maxTurns: 30,
  conditions: [
    // === 乌克兰（守）胜利条件 ===
    {
      id: 'ukraine-hold-to-end',
      factionId: 'ukraine',
      type: 'turn_limit',
      description:
        '乌军坚守至战役回合上限（30 回合，挫败俄军速战速决企图，战争转入持久消耗）',
    },
    {
      id: 'ukraine-recapture-kherson',
      factionId: 'ukraine',
      type: 'objective',
      description:
        '乌军反攻收复赫尔松（史实 2022/11 乌军反攻收复赫尔松市，标志南线反攻胜利）',
      nodeId: 'kherson',
    },
    {
      id: 'ukraine-defend-kyiv',
      factionId: 'ukraine',
      type: 'objective',
      description:
        '乌军确保基辅不失（守住首都，俄军北线攻势彻底失败）',
      nodeId: 'kyiv',
    },
    // === 俄罗斯（攻）胜利条件 ===
    {
      id: 'russia-capture-kyiv',
      factionId: 'russia',
      type: 'objective',
      description:
        '俄军攻占基辅（推翻泽连斯基政权，实现"政权更迭"战略目标）',
      nodeId: 'kyiv',
    },
    {
      id: 'russia-attrition-ukraine',
      factionId: 'russia',
      type: 'casualty',
      description:
        '消耗乌军：乌军战损超过 60%（以重型装甲/远程炮兵火力碾压压垮乌克兰抗战意志）',
      targetFactionId: 'ukraine',
      casualtyThreshold: 0.6,
    },
    // === 北约胜利条件（第 3 批新增） ===
    // 北约不直接参战，其胜利绑定乌方生存：乌克兰守住基辅至回合上限即视为北约军援/制裁战略成功。
    {
      id: 'nato-ukraine-survives',
      factionId: 'nato',
      type: 'objective',
      description:
        '乌克兰守住基辅至战役回合上限（北约军援/情报/制裁战略成功，俄军速战速决企图彻底破产）',
      nodeId: 'kyiv',
    },
  ],
}

/**
 * 凡尔登战役 1916 — rules.json 数据（堑壕战数值规则覆盖）。
 *
 * 史实特征（查证自维基/百科）：
 * - 堑壕战：双方构筑堑壕工事，防御加成极高，进攻方伤亡惨重。
 * - 重炮压制：德军"大贝尔莎"420mm 重炮轰击要塞；炮击压制步兵使其无法机动。
 * - 消耗损耗：长期对峙双方均承受持续战损（弹药消耗、人员损耗）。
 * - 情报半衰：侦察命中后失去实时侦察，情报残影按半衰降级（halfLifeTurns=3）。
 *
 * @module data/verdun-1916/rules
 */

import type { CampaignRules } from '@/types'

/** 凡尔登堑壕战数值规则 */
export const verdunRules: CampaignRules = {
  intelDecay: {
    // 情报半衰期 3 回合（每回合≈10天 → 半衰约 30 天），与 PRD §6 半衰草案一致
    halfLifeTurns: 3,
    // 每半衰降级 1 级（Level 3 → 2 → 1）
    decayPerHalfLife: 1,
  },
  combat: {
    // 堑壕战消耗损耗率（每回合双方均承受持续损耗）
    attritionRate: 0.08,
    // 重炮压制强度（被炮击单位本回合无法机动/减效）
    artillerySuppression: 0.6,
    // 要塞防御加成（杜奥蒙/沃/苏维尔，配合 map cell defenseBonus）
    fortressDefenseBonus: 0.85,
    // 堑壕防御加成（野战工事）
    trenchDefenseBonus: 0.5,
  },
  movement: {
    // 基础机动点数（堑壕战机动受限）
    baseMovementPoints: 2,
    // 渡默兹河惩罚（高移动消耗）
    riverCrossingPenalty: 4,
    // 每次机动增加疲劳
    fatiguePerMove: 5,
  },
  supply: {
    // 每回合维持消耗（弹药/物资）
    sustainCostPerTurn: 8,
    // 低补给阈值（低于此值触发 low_supply 状态）
    lowSupplyThreshold: 25,
    // 补给回复率（"神圣之路"后勤轮换使法军回复较快）
    restockRate: 15,
  },
}

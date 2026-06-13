/**
 * 战斗结算桩（combat.ts）— 纯函数（铁律边界）。
 *
 * 战损计算、压制/要塞防御加成等纯数值规则。确定性种子 = scenarioSeed:turn:seq。
 * 回放时 physics 类 event-log 校验重算一致。
 *
 * 里程碑：M2（物理 Worker + physics-rules）。
 *
 * @module layers/domain/combat
 */

/**
 * 战斗结算输入（草案，M2 由子代理完善字段）。
 */
export interface CombatInput {
  /** 确定性种子 */
  seed: string
}

/**
 * 战斗结算桩。
 *
 * TODO(M2): 由后续子代理实现完整数值规则（战损/压制/要塞加成/消耗损耗）。
 */
export function resolveCombat(_input: CombatInput): void {
  // TODO(M2): 纯数值规则结算
}

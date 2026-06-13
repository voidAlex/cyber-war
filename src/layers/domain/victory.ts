/**
 * 胜负判定桩（victory.ts）— 纯函数（铁律边界）。
 *
 * 读取 campaign 的 victory.json 条件，判定阵营胜负（占节点 / 战损阈值 / 回合上限）。
 *
 * 里程碑：M2（基础胜负）/ M4（完整胜负条件）。
 *
 * @module layers/domain/victory
 */

/**
 * 胜负判定结果（草案）。
 */
export interface VictoryResult {
  /** 是否已分出胜负 */
  decided: boolean
  /** 获胜阵营 id（未决为 null） */
  winnerFactionId: string | null
  /** 判定原因 */
  reason: string | null
}

/**
 * 胜负判定桩。
 * TODO(M2/M4): 由后续子代理实现完整胜负条件判定。
 */
export function checkVictory(): VictoryResult {
  // TODO(M2/M4): 读取 victory 条件判定
  return { decided: false, winnerFactionId: null, reason: null }
}

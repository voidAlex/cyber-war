/**
 * 胜负判定（victory.ts）— 纯函数。
 *
 * 读取 victory 条件（占领节点 / 战损阈值 / 回合上限），判定阵营胜负。
 *
 * 数值假设（M2 草案，凡尔登 1916 量级）：
 * - 胜负条件由战役包 victory.json 定义；domain 读取「已达成条件」判定。
 * - 三类条件：objective（占领指定高价值节点）、casualty（某阵营累计战损超阈值）、
 *   turnLimit（回合上限到达，按累计优势/目标达成度裁定）。
 *
 * 全纯函数。Worker 结算后调用 checkVictory 判定本回合是否终结。
 *
 * @module layers/domain/victory
 */

import type { WorldState } from '@/types'

/**
 * 胜负判定结果。
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
 * 单条胜负条件（由战役包 victory.json 提供或 domain 默认）。
 */
export interface VictoryCondition {
  /** 满足此条件即获胜的阵营 id */
  factionId: string
  /** 条件类型 */
  kind: 'objective' | 'casualty' | 'turnLimit'
  /**
   * 目标参数：
   * - objective：需占领的高价值节点 id 列表
   * - casualty：需达到的敌方累计战损阈值（strength 总损失）
   * - turnLimit：回合上限（到达后此阵营按达成度裁定）
   */
  target: string[] | number
}

/**
 * 胜负判定输入。
 */
export interface VictoryCheckInput {
  /** 当前世界状态（读占领状态/战损/回合） */
  world: WorldState
  /** 当前各阵营占领的高价值节点 id 列表（key=factionId） */
  controlledNodes: Record<string, string[]>
  /** 当前各阵营累计承受的 strength 战损（key=factionId，承受方） */
  accumulatedCasualties: Record<string, number>
  /** 胜负条件列表（来自 victory.json） */
  conditions: VictoryCondition[]
}

/**
 * 默认空胜负判定（未决）。
 *
 * 保留无参重载以兼容现有 barrel 导出（checkVictory()）。
 */
export function checkVictory(input?: VictoryCheckInput): VictoryResult {
  if (!input) {
    return { decided: false, winnerFactionId: null, reason: null }
  }
  const { world, controlledNodes, accumulatedCasualties, conditions } = input

  // 1. objective 条件：某阵营占领全部指定节点 → 胜
  for (const cond of conditions) {
    if (cond.kind !== 'objective') continue
    const required = cond.target as string[]
    const held = controlledNodes[cond.factionId] ?? []
    if (required.length > 0 && required.every((nodeId) => held.includes(nodeId))) {
      return {
        decided: true,
        winnerFactionId: cond.factionId,
        reason: `占领全部目标节点：${required.join(', ')}`,
      }
    }
  }

  // 2. casualty 条件：某阵营使敌方累计战损超阈值 → 该阵营胜
  for (const cond of conditions) {
    if (cond.kind !== 'casualty') continue
    const threshold = cond.target as number
    // 此条件语义：cond.factionId「使敌方战损超阈值」即胜。
    // 汇总除自身外所有阵营承受的战损。
    let enemyLoss = 0
    for (const [factionId, loss] of Object.entries(accumulatedCasualties)) {
      if (factionId !== cond.factionId) enemyLoss += loss
    }
    if (enemyLoss >= threshold) {
      return {
        decided: true,
        winnerFactionId: cond.factionId,
        reason: `敌方累计战损 ${enemyLoss} 超阈值 ${threshold}`,
      }
    }
  }

  // 3. turnLimit 条件：到达回合上限，按占领节点数裁定（多者胜，平则未决）
  for (const cond of conditions) {
    if (cond.kind !== 'turnLimit') continue
    const limit = cond.target as number
    if (world.turnIndex >= limit) {
      // 在所有阵营中找占领高价值节点最多者
      let bestFaction: string | null = null
      let bestCount = -1
      let tie = false
      for (const [factionId, nodes] of Object.entries(controlledNodes)) {
        if (nodes.length > bestCount) {
          bestCount = nodes.length
          bestFaction = factionId
          tie = false
        } else if (nodes.length === bestCount) {
          tie = true
        }
      }
      if (bestFaction && !tie && bestCount > 0) {
        return {
          decided: true,
          winnerFactionId: bestFaction,
          reason: `回合上限 ${limit} 到达，${bestFaction} 占领节点数领先（${bestCount}）`,
        }
      }
      // 平局或无人占领 → 仍判定为本条件的提出方按平局记，标记未决但回合结束
      return {
        decided: false,
        winnerFactionId: null,
        reason: `回合上限 ${limit} 到达，势均力敌`,
      }
    }
  }

  return { decided: false, winnerFactionId: null, reason: null }
}

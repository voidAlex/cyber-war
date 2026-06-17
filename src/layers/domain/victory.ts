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

import type { WorldState, CampaignVictory, CampaignVictoryCondition } from '@/types'
import { getBuiltinVictory } from '@/data/registry'

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
 *
 * 第 5 批扩展：
 * - score：积分制——某阵营累计积分达 scoreThreshold 即胜。
 * - cumulative：累计目标——某阵营累计达成某度量（歼敌人数/占点回合数/积分）达 cumulativeTarget 即胜。
 */
export interface VictoryCondition {
  /** 满足此条件即获胜的阵营 id */
  factionId: string
  /** 条件类型 */
  kind: 'objective' | 'casualty' | 'turnLimit' | 'score' | 'cumulative'
  /**
   * 目标参数：
   * - objective：需占领的高价值节点 id 列表
   * - casualty：需达到的敌方累计战损阈值（strength 总损失）
   * - turnLimit：回合上限（到达后此阵营按达成度裁定）
   * - score：积分阈值（累计积分达此值即胜）
   * - cumulative：累计目标阈值（配合 cumulativeMetric 语义）
   */
  target: string[] | number
  /**
   * cumulative 类型的度量字段（第 5 批）。
   *
   * - 'casualties_inflicted'：该阵营累计造成的敌方 personnel 损失（默认）。
   * - 'objectives_held_turns'：该阵营累计占领高价值节点的回合数。
   * - 'score'：该阵营累计积分。
   * 缺省 'casualties_inflicted'（仅 cumulative 类型用）。
   */
  cumulativeMetric?: 'casualties_inflicted' | 'objectives_held_turns' | 'score'
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
  /**
   * 各阵营累计积分（第 5 批 score 类型用，key=factionId）。
   * 由调用方按「占节点+100/歼敌+10/回合-5」等规则累计；缺省 0。
   */
  scores?: Record<string, number>
  /**
   * 各阵营累计造成的敌方 personnel 伤亡（第 5 批 cumulative casualties_inflicted 用，
   * key=施加方 factionId）。与 accumulatedCasualties（承受方视角）互补。
   * 缺省时回退用 accumulatedCasualties 反推。
   */
  casualtiesInflicted?: Record<string, number>
  /**
   * 各阵营累计占领高价值节点的回合数（第 5 批 cumulative objectives_held_turns 用，
   * key=factionId）。缺省 0。
   */
  objectivesHeldTurns?: Record<string, number>
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

  // 4. score 条件（第 5 批）：某阵营累计积分达阈值即胜。
  // 积分由调用方累计（占节点+100/歼敌+10/回合-5 等规则），存于 input.scores。
  for (const cond of conditions) {
    if (cond.kind !== 'score') continue
    const threshold = cond.target as number
    const score = input.scores?.[cond.factionId] ?? 0
    if (score >= threshold) {
      return {
        decided: true,
        winnerFactionId: cond.factionId,
        reason: `积分 ${score} 达阈值 ${threshold}`,
      }
    }
  }

  // 5. cumulative 条件（第 5 批）：某阵营累计度量达阈值即胜。
  // 度量由 cumulativeMetric 决定（casualties_inflicted/objectives_held_turns/score）。
  for (const cond of conditions) {
    if (cond.kind !== 'cumulative') continue
    const threshold = cond.target as number
    const metric = cond.cumulativeMetric ?? 'casualties_inflicted'
    let value: number
    if (metric === 'objectives_held_turns') {
      value = input.objectivesHeldTurns?.[cond.factionId] ?? 0
    } else if (metric === 'score') {
      value = input.scores?.[cond.factionId] ?? 0
    } else {
      // casualties_inflicted：优先用显式统计；缺失时回退用敌方累计承受战损总和
      value = input.casualtiesInflicted?.[cond.factionId] ?? sumEnemyLoss(accumulatedCasualties, cond.factionId)
    }
    if (value >= threshold) {
      return {
        decided: true,
        winnerFactionId: cond.factionId,
        reason: `累计 ${metric} ${value} 达阈值 ${threshold}`,
      }
    }
  }

  return { decided: false, winnerFactionId: null, reason: null }
}

/**
 * 汇总除指定阵营外所有阵营累计承受的战损（cumulative casualties_inflicted 回退用）。
 */
function sumEnemyLoss(
  accumulatedCasualties: Record<string, number>,
  factionId: string,
): number {
  let sum = 0
  for (const [fid, loss] of Object.entries(accumulatedCasualties)) {
    if (fid !== factionId) sum += loss
  }
  return sum
}

// =============================================================================
// 第 6 批：evaluateVictory —— 编排器在每回合 FINISH_RESOLUTION 后调用的高层入口
//
// 职责：
// 1. 从内置 registry 查当前 world.scenarioId 的 CampaignVictory（条件 + maxTurns）。
//    未注册则跳过判定（返回 world 原样，victoryState 保持 ongoing）。
// 2. 把 CampaignVictoryCondition（type/factionId/nodeId/casualtyThreshold/...）
//    翻译为 domain VictoryCondition（kind/target）。
// 3. 用本回合 lastResolution 折叠更新累计统计（accumulatedCasualties /
//    casualtiesInflicted / controlledNodes / factionScores / objectivesHeldTurns）。
// 4. 调 checkVictory 判定，写入 world.victoryState/winnerFactionId/victoryReason。
//
// 全纯函数（输入 world + 可选 victory，输出新 world；不读 store / 不调 LLM）。
// 旧存档兼容：world 各累计字段缺失时按 0/空 起算（首回合）。
// =============================================================================

/**
 * 玩家阵营视角的胜负终局状态（world.victoryState 的语义）。
 *
 * - 'ongoing'：未决。
 * - 'won'：玩家阵营获胜（winnerFactionId === playerFactionId）。
 * - 'lost'：玩家阵营失败（winnerFactionId 为敌方）。
 * - 'draw'：平局（回合上限到达且势均力敌）。
 */
export type VictoryState = 'ongoing' | 'won' | 'lost' | 'draw'

/**
 * evaluateVictory 的可选注入参数（测试/mock 用）。
 *
 * 默认从 getBuiltinVictory(world.scenarioId) 取 CampaignVictory；
 * 测试可显式传入以绕过 registry（如自定义胜利条件）。
 */
export interface EvaluateVictoryOptions {
  /** 显式注入的胜负条件（覆盖 registry 查询） */
  victory?: CampaignVictory
}

/**
 * 把 CampaignVictoryCondition（剧本数据形态）翻译为 domain VictoryCondition。
 *
 * 字段映射：
 * - type 'objective' → kind 'objective'，target = [nodeId]
 * - type 'casualty' → kind 'casualty'，target = casualtyThreshold × 100
 *   （Campaign casualtyThreshold 是 0..1 比例，domain 是绝对值；按各阵营初始
 *   总 strength × 比例换算为绝对阈值）
 * - type 'turn_limit' → kind 'turnLimit'，target = victory.maxTurns
 * - type 'score' → kind 'score'，target = scoreThreshold
 * - type 'cumulative' → kind 'cumulative'，target = cumulativeTarget + cumulativeMetric
 *
 * @param cond 剧本胜负条件
 * @param victory 所属 CampaignVictory（提供 maxTurns 给 turn_limit）
 * @param initialStrengthByFaction 各阵营初始总 strength（casualty 比例换算用）
 */
function translateCondition(
  cond: CampaignVictoryCondition,
  victory: CampaignVictory,
  initialStrengthByFaction: Record<string, number>,
): VictoryCondition | null {
  switch (cond.type) {
    case 'objective':
      // 缺 nodeId 的 objective 视为无效（跳过）。
      if (!cond.nodeId) return null
      return {
        factionId: cond.factionId,
        kind: 'objective',
        target: [cond.nodeId],
      }
    case 'casualty': {
      // casualtyThreshold 是 0..1 比例（针对 targetFactionId 的初始 strength）。
      const targetFaction = cond.targetFactionId ?? cond.factionId
      const initial = initialStrengthByFaction[targetFaction] ?? 0
      const threshold = Math.round(initial * (cond.casualtyThreshold ?? 1))
      return {
        // Campaign 语义：cond.factionId「使 targetFactionId 战损超阈值即胜」。
        // domain casualty 语义：cond.factionId「使敌方累计战损超阈值即胜」
        // （敌方 = 除自身外所有阵营累计承受的 strength 损失）。
        factionId: cond.factionId,
        kind: 'casualty',
        target: threshold,
      }
    }
    case 'turn_limit':
      return {
        factionId: cond.factionId,
        kind: 'turnLimit',
        target: victory.maxTurns,
      }
    case 'score':
      return {
        factionId: cond.factionId,
        kind: 'score',
        target: cond.scoreThreshold ?? Number.POSITIVE_INFINITY,
      }
    case 'cumulative':
      return {
        factionId: cond.factionId,
        kind: 'cumulative',
        target: cond.cumulativeTarget ?? Number.POSITIVE_INFINITY,
        cumulativeMetric: cond.cumulativeMetric ?? 'casualties_inflicted',
      }
    default:
      return null
  }
}

/**
 * 计算各阵营初始总 strength（按当前 world.units 的 maxPersonnel 近似）。
 *
 * casualty 比例阈值需要初始总 strength 作为分母。world.units 上的 personnel
 * 会随战损下降，但 maxPersonnel 是编制上限（近似初始值），故用 maxPersonnel
 * 之和作为初始总 strength 的代理。
 *
 * @param world 当前世界状态
 * @returns factionId → 初始总 strength（maxPersonnel 之和）
 */
function computeInitialStrengthByFaction(world: WorldState): Record<string, number> {
  const result: Record<string, number> = {}
  for (const u of world.units) {
    result[u.factionId] = (result[u.factionId] ?? 0) + (u.maxPersonnel ?? 0)
  }
  return result
}

/**
 * 取玩家阵营 id（与 ui/sandbox/intel-visibility.getPlayerFactionId 同语义）。
 *
 * 优先 world.playerFactionId（v0.2.2+ 权威），否则 fallback side==='player'。
 */
function getPlayerFactionId(world: WorldState): string {
  if (world.playerFactionId && world.playerFactionId.length > 0) {
    return world.playerFactionId
  }
  return world.factions.find((f) => f.side === 'player')?.id ?? ''
}

/**
 * 折叠更新累计统计：基于本回合 lastResolution，更新 world 上的累计字段。
 *
 * - accumulatedCasualties：累加本回合各阵营承受的 strength 损失。
 * - casualtiesInflicted：累加本回合各阵营造成的敌方 personnel 损失
 *   （粗粒度：某阵营造成的 = 除自身外其他阵营本回合承受的 personnel 损失之和）。
 * - controlledNodes：按本回合 objectiveChanges 折叠（最新控制方覆盖）。
 * - factionScores：占节点+100 / 歼敌+10 / 回合-5（仅当本回合有结算）。
 * - objectivesHeldTurns：按当前 controlledNodes[factionId].length 累加。
 *
 * 全纯函数（不修改入参，返回新对象）。
 *
 * @param world 当前世界状态（含本回合 lastResolution）
 * @returns 更新累计字段后的新 world（浅拷贝顶层 + 各累计字段）
 */
export function accumulateTurnStats(world: WorldState): WorldState {
  const resolution = world.lastResolution
  // 累计统计的浅拷贝（旧存档缺失字段按空对象起算）
  const accumulatedCasualties: Record<string, number> = { ...(world.accumulatedCasualties ?? {}) }
  const casualtiesInflicted: Record<string, number> = { ...(world.casualtiesInflicted ?? {}) }
  const controlledNodes: Record<string, string[]> = {}
  for (const [fid, nodes] of Object.entries(world.controlledNodes ?? {})) {
    controlledNodes[fid] = [...nodes]
  }
  const factionScores: Record<string, number> = { ...(world.factionScores ?? {}) }
  const objectivesHeldTurns: Record<string, number> = { ...(world.objectivesHeldTurns ?? {}) }

  // 仅当本回合有结算结果时累加（首回合 / 恢复态可能无 lastResolution）。
  if (resolution) {
    // 1. accumulatedCasualties：累加本回合各阵营承受的 strength 损失。
    const personnelByFaction: Record<string, number> = {}
    for (const [fid, loss] of Object.entries(resolution.casualties)) {
      accumulatedCasualties[fid] = (accumulatedCasualties[fid] ?? 0) + (loss.strength ?? 0)
      personnelByFaction[fid] = (personnelByFaction[fid] ?? 0) + (loss.personnel ?? 0)
    }

    // 2. casualtiesInflicted：粗粒度——某阵营造成的敌方 personnel 损失 =
    //    除自身外其他阵营本回合承受的 personnel 损失之和。
    //    （假设本回合所有敌方损失都由我方造成；多阵营混战时会高估，可接受。）
    const factionIds = new Set<string>()
    for (const f of world.factions) factionIds.add(f.id)
    const totalPersonnelLoss = Object.values(personnelByFaction).reduce((s, v) => s + v, 0)
    for (const fid of factionIds) {
      const myLoss = personnelByFaction[fid] ?? 0
      const enemyLoss = totalPersonnelLoss - myLoss
      if (enemyLoss > 0) {
        casualtiesInflicted[fid] = (casualtiesInflicted[fid] ?? 0) + enemyLoss
      }
    }

    // 3. controlledNodes：按本回合 objectiveChanges 折叠（最新控制方覆盖）。
    for (const change of resolution.objectiveChanges) {
      // 先从所有阵营的列表中移除该节点（避免重复归属）。
      for (const fid of Object.keys(controlledNodes)) {
        controlledNodes[fid] = controlledNodes[fid].filter((n) => n !== change.nodeId)
      }
      // 加入新控制方列表。
      if (!controlledNodes[change.toFactionId]) {
        controlledNodes[change.toFactionId] = []
      }
      controlledNodes[change.toFactionId].push(change.nodeId)
    }

    // 4. factionScores：占节点+100 / 歼敌+10 / 回合-5。
    for (const change of resolution.objectiveChanges) {
      factionScores[change.toFactionId] = (factionScores[change.toFactionId] ?? 0) + 100
    }
    for (const [fid, inflicted] of Object.entries(casualtiesInflicted)) {
      // 用本回合增量（已在 casualtiesInflicted 累加，但 score 需按本回合 personnel 增量）。
      const myPersonnelInflicted = (totalPersonnelLoss - (personnelByFaction[fid] ?? 0))
      if (myPersonnelInflicted > 0) {
        // 每 10 personnel +1 分（避免数值过大）。
        factionScores[fid] = (factionScores[fid] ?? 0) + Math.floor(myPersonnelInflicted / 10)
      }
      // 触碰 inflicted 避免未使用警告（保留语义）。
      void inflicted
    }
    for (const fid of factionIds) {
      factionScores[fid] = (factionScores[fid] ?? 0) - 5
    }
  }

  // 5. objectivesHeldTurns：按当前 controlledNodes[factionId].length 累加（每回合 +1 × 占领数）。
  //    注意：仅在已完成结算的回合累加（lastResolution 存在时）。
  if (resolution) {
    for (const [fid, nodes] of Object.entries(controlledNodes)) {
      if (nodes.length > 0) {
        objectivesHeldTurns[fid] = (objectivesHeldTurns[fid] ?? 0) + nodes.length
      }
    }
  }

  return {
    ...world,
    accumulatedCasualties,
    casualtiesInflicted,
    controlledNodes,
    factionScores,
    objectivesHeldTurns,
  }
}

/**
 * 评估胜负并写入 world.victoryState（高层入口）。
 *
 * 调用时机：编排器 advanceTurn / resumeTurnAfterDecision 在 FINISH_RESOLUTION
 * 之后调用。流程：
 * 1. accumulateTurnStats：折叠累计统计。
 * 2. 查 CampaignVictory（registry 或显式注入）。
 * 3. 翻译条件 → 调 checkVictory。
 * 4. 按玩家阵营视角写 victoryState（won/lost/draw/ongoing）。
 *
 * 已终局（victoryState !== 'ongoing'）时不再重复判定（幂等，返回原 world）。
 *
 * @param world 当前世界状态（应已含本回合 lastResolution）
 * @param options 可选注入（测试用）
 * @returns 更新累计统计 + victoryState 后的新 world
 */
export function evaluateVictory(
  world: WorldState,
  options?: EvaluateVictoryOptions,
): WorldState {
  // 幂等：已终局则不再判定。
  if (world.victoryState && world.victoryState !== 'ongoing') {
    return world
  }

  // 1. 折叠累计统计。
  const worldWithStats = accumulateTurnStats(world)

  // Bug C 修复（2026-06）：通用"全军覆没"兜底判定（独立于战役注册条件）。
  //
  // 某阵营所有单位 strength<=0（含歼灭/投降/溃散后归零）→ 该阵营负，
  // 对方阵营（首个仍有 strength>0 单位的非同阵营）胜。
  // 这保证 Bug C 主动投降（玩家方全军 strength=0）即便战役未注册歼灭条件
  // 也能触发对方胜利（确定性，无随机）。
  //
  // 多阵营场景：任一阵营覆灭即判负，胜方取"首个未覆灭的非负方阵营"
  // （简化：避免复杂的多边胜负裁决；后续可扩展为 last-man-standing）。
  // 平局兜底：所有阵营同时覆灭（罕见）→ draw。
  const annihilationResult = checkAnnihilation(worldWithStats)
  if (annihilationResult.decided) {
    const playerFactionId = getPlayerFactionId(worldWithStats)
    let victoryState: VictoryState
    if (annihilationResult.winnerFactionId === null) {
      // 所有阵营同时覆灭 → 平局
      victoryState = 'draw'
    } else if (annihilationResult.winnerFactionId === playerFactionId) {
      // 对方覆灭，玩家方仍有单位 → 玩家胜
      victoryState = 'won'
    } else {
      // 玩家方覆灭（含主动投降）→ 玩家负
      victoryState = 'lost'
    }
    return {
      ...worldWithStats,
      victoryState,
      winnerFactionId: annihilationResult.winnerFactionId,
      victoryReason: annihilationResult.reason,
    }
  }

  // 2. 查 CampaignVictory。
  const victory = options?.victory ?? getBuiltinVictory(world.scenarioId)
  if (!victory) {
    // 未注册胜利条件：仅更新累计统计，victoryState 保持 ongoing。
    return { ...worldWithStats, victoryState: 'ongoing' }
  }

  // 3. 翻译条件。
  const initialStrength = computeInitialStrengthByFaction(worldWithStats)
  const conditions: VictoryCondition[] = []
  for (const cond of victory.conditions) {
    const translated = translateCondition(cond, victory, initialStrength)
    if (translated) conditions.push(translated)
  }

  // 4. 调 checkVictory。
  const result = checkVictory({
    world: worldWithStats,
    controlledNodes: worldWithStats.controlledNodes ?? {},
    accumulatedCasualties: worldWithStats.accumulatedCasualties ?? {},
    conditions,
    scores: worldWithStats.factionScores,
    casualtiesInflicted: worldWithStats.casualtiesInflicted,
    objectivesHeldTurns: worldWithStats.objectivesHeldTurns,
  })

  // 5. 按玩家阵营视角写 victoryState。
  const playerFactionId = getPlayerFactionId(worldWithStats)
  let victoryState: VictoryState
  if (!result.decided) {
    // checkVictory 的 turnLimit 在到达上限但平局时返回 decided:false + reason（势均力敌）。
    // 此处据 reason 判定是否为平局（reason 含「势均力敌」或回合上限到达）。
    if (
      result.reason &&
      worldWithStats.turnIndex >= victory.maxTurns &&
      result.reason.includes('势均力敌')
    ) {
      victoryState = 'draw'
    } else {
      victoryState = 'ongoing'
    }
  } else if (result.winnerFactionId === null) {
    victoryState = 'draw'
  } else if (result.winnerFactionId === playerFactionId) {
    victoryState = 'won'
  } else {
    victoryState = 'lost'
  }

  return {
    ...worldWithStats,
    victoryState,
    winnerFactionId: result.winnerFactionId,
    victoryReason: result.reason,
    victoryMaxTurns: victory.maxTurns,
  }
}

/**
 * Bug C 修复：通用"全军覆没"判定（独立于战役注册条件）。
 *
 * 扫描 world.factions，若某阵营在 world.units 中无任何 strength>0 的单位
 * （全军覆灭/投降），则判定该阵营负，胜方取"首个仍有 strength>0 单位的非覆灭阵营"。
 *
 * 全部阵营同时覆灭 → decided:true 但 winnerFactionId:null（平局）。
 * 无任何阵营覆灭 → decided:false（ongoing）。
 *
 * 确定性：纯数值扫描，无随机。
 *
 * @param world 当前世界状态
 * @returns 判定结果（decided/winnerFactionId/reason）
 */
function checkAnnihilation(world: WorldState): {
  decided: boolean
  winnerFactionId: string | null
  reason: string | null
} {
  if (world.factions.length === 0 || world.units.length === 0) {
    return { decided: false, winnerFactionId: null, reason: null }
  }
  // 各阵营是否仍有 strength>0 的单位
  const hasAlive = new Map<string, boolean>()
  for (const f of world.factions) {
    hasAlive.set(f.id, false)
  }
  for (const u of world.units) {
    if (u.strength > 0 && hasAlive.has(u.factionId)) {
      hasAlive.set(u.factionId, true)
    }
  }
  const annihilatedFactions = world.factions.filter((f) => !hasAlive.get(f.id))
  if (annihilatedFactions.length === 0) {
    return { decided: false, winnerFactionId: null, reason: null }
  }
  // 取首个仍有单位的非覆灭阵营作为胜方
  const winner = world.factions.find((f) => hasAlive.get(f.id)) ?? null
  const loserNames = annihilatedFactions.map((f) => f.name || f.id).join('、')
  if (winner === null) {
    // 所有阵营同时覆灭（罕见）
    return {
      decided: true,
      winnerFactionId: null,
      reason: `全员覆灭（${loserNames}），势均力敌`,
    }
  }
  return {
    decided: true,
    winnerFactionId: winner.id,
    reason: `${loserNames} 全军覆没`,
  }
}

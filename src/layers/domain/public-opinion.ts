/**
 * 舆论战/民心（public-opinion.ts）— 纯函数。
 *
 * T2 第 3 批：每回合根据战损/胜负/补给/外交调整阵营 publicWill 与 internationalOpinion。
 *
 * 设计（重写计划「第 3 批 舆论战」）：
 * - updatePublicWill(world)：胜利 +3 / 失败 -5 / 低补给 -2 / 回合基线 -1（战争疲劳）。
 *   publicWill < 20 → 兵变风险陡升 + 全军 morale -10。
 * - updateInternationalOpinion(world)：外交行动 +5~10 / 核设施打击 -10 / 平民区战斗 -5。
 *   internationalOpinion < 30 → 军援（reinforcement）事件不触发。
 *
 * 全纯函数，不可变产出：返回新 Faction[]，调用方（turn-resolution）落地到 worldState.factions。
 *
 * 确定性：纯数值计算（基于 lastResolution.casualties/objectiveChanges + faction.supply），
 * 兵变概率判定由调用方注入 DeterministicRandom（本函数仅产出 morale 惩罚与 publicWill 变化，
 * 不掷骰子——兵变事件本身由 random-events.mutiny 模板驱动，本函数仅提供数值信号）。
 *
 * @module layers/domain/public-opinion
 */

import type { Faction, WorldState, ResolutionSummary } from '@/types'

/** publicWill 缺省初值（旧存档无此字段时回填）。 */
export const DEFAULT_PUBLIC_WILL = 60
/** internationalOpinion 缺省初值（旧存档无此字段时回填）。 */
export const DEFAULT_INTERNATIONAL_OPINION = 50
/** publicWill 危机阈值（低于此值 → 全军 morale -10 + 兵变风险陡升）。 */
export const PUBLIC_WILL_CRISIS_THRESHOLD = 20
/** internationalOpinion 军援中断阈值（低于此值 → reinforcement 事件不触发）。 */
export const OPINION_AID_CUTOFF_THRESHOLD = 30

/** publicWill 调整项（每回合累计）。 */
export interface PublicWillDelta {
  /** 胜利（占领敌方节点）加成 */
  victory: number
  /** 失败（丢失己方节点 / 承受大量战损）惩罚 */
  defeat: number
  /** 低补给惩罚（faction.supply.supplies < lowSupplyThreshold） */
  lowSupply: number
  /** 回合基线消耗（战争疲劳，每回合 -1） */
  baseline: number
}

/** 单回合 publicWill 调整常量（重写计划「第 3 批」）。 */
export const PUBLIC_WILL_DELTAS: PublicWillDelta = {
  victory: 3,
  defeat: -5,
  lowSupply: -2,
  baseline: -1,
}

/** internationalOpinion 调整项（事件驱动，非回合基线）。 */
export interface InternationalOpinionDelta {
  /** 外交行动成功（盟友履约） */
  diplomacy: number
  /** 核设施打击（民用/敏感目标） */
  nuclearStrike: number
  /** 平民区/城市战斗 */
  civilianCasualty: number
}

/**
 * 计算某阵营本回合 publicWill 调整并返回新值（含 crises 触发的 morale 惩罚）。
 *
 * 规则（重写计划「第 3 批」）：
 * - 占领敌方高价值节点（objectiveChanges.toFactionId === faction.id）→ victory +3。
 * - 丢失己方节点（objectiveChanges.fromFactionId === faction.id）→ defeat -5。
 * - faction.supply.supplies < 25（低补给阈值）→ lowSupply -2。
 * - 每回合基线 -1（战争疲劳）。
 * - publicWill < 20 → 标记 moralePenalty=true（调用方据此给该阵营全军 morale -10）。
 *
 * @param faction 当前阵营（只读，读取 publicWill/supply）
 * @param resolution 上回合结算摘要（读 casualties/objectiveChanges 判胜负）
 * @returns { publicWill: 新值, moralePenalty: 是否触发全军 morale-10 惩罚 }
 */
export function updatePublicWillForFaction(
  faction: Faction,
  resolution: ResolutionSummary | null,
): { publicWill: number; moralePenalty: boolean } {
  const cur = faction.publicWill ?? DEFAULT_PUBLIC_WILL
  let delta = PUBLIC_WILL_DELTAS.baseline // 回合基线 -1

  // 低补给惩罚
  if (faction.supply.supplies < 25) {
    delta += PUBLIC_WILL_DELTAS.lowSupply
  }

  // 胜负（基于 objectiveChanges）
  if (resolution) {
    for (const change of resolution.objectiveChanges) {
      if (change.toFactionId === faction.id) {
        // 占领敌方节点 → 胜利 +3
        delta += PUBLIC_WILL_DELTAS.victory
      } else if (change.fromFactionId === faction.id) {
        // 丢失己方节点 → 失败 -5
        delta += PUBLIC_WILL_DELTAS.defeat
      }
    }
    // 承受大量战损 → 失败惩罚（personnel 损失 > 50 视为重创）
    const myCasualty = resolution.casualties[faction.id]
    if (myCasualty && myCasualty.personnel > 50) {
      delta += PUBLIC_WILL_DELTAS.defeat
    }
  }

  const next = Math.max(0, Math.min(100, cur + delta))
  const moralePenalty = next < PUBLIC_WILL_CRISIS_THRESHOLD
  return { publicWill: next, moralePenalty }
}

/**
 * 计算某阵营本回合 internationalOpinion 调整并返回新值。
 *
 * 规则（重写计划「第 3 批」）：
 * - 默认每回合 0（无基线，仅事件驱动）。
 * - 占领敌方节点 → diplomacy +5（战场胜利获国际认可）。
 * - 丢失己方节点 → diplomacy -5（战场失利失国际信心）。
 * - 核设施打击 / 平民区战斗由调用方据事件传 eventFlags（本函数默认无调整）。
 *
 * @param faction 当前阵营（只读）
 * @param resolution 上回合结算摘要
 * @returns 新 internationalOpinion（0..100）
 */
export function updateInternationalOpinionForFaction(
  faction: Faction,
  resolution: ResolutionSummary | null,
): number {
  const cur = faction.internationalOpinion ?? DEFAULT_INTERNATIONAL_OPINION
  let delta = 0

  if (resolution) {
    for (const change of resolution.objectiveChanges) {
      if (change.toFactionId === faction.id) {
        delta += 5
      } else if (change.fromFactionId === faction.id) {
        delta -= 5
      }
    }
  }

  return Math.max(0, Math.min(100, cur + delta))
}

/**
 * 更新所有阵营的 publicWill（每回合结算后调用）。
 *
 * 返回新 Faction[]（不可变产出）。若某阵营 publicWill < 阈值 → moralePenalty=true，
 * 调用方据此给该阵营全军 morale -10（在 turn-resolution 中应用）。
 *
 * @param world 当前世界状态（只读）
 * @param resolution 上回合结算摘要
 * @returns 新 factions 数组 + 触发兵变惩罚的阵营 id 列表
 */
export function updatePublicWill(
  world: WorldState,
  resolution: ResolutionSummary | null,
): { factions: Faction[]; crisisFactionIds: string[] } {
  const crisisFactionIds: string[] = []
  const factions = world.factions.map((f) => {
    const { publicWill, moralePenalty } = updatePublicWillForFaction(f, resolution)
    if (moralePenalty) crisisFactionIds.push(f.id)
    return { ...f, publicWill }
  })
  return { factions, crisisFactionIds }
}

/**
 * 更新所有阵营的 internationalOpinion（每回合结算后调用）。
 *
 * @param world 当前世界状态（只读）
 * @param resolution 上回合结算摘要
 * @returns 新 factions 数组
 */
export function updateInternationalOpinion(
  world: WorldState,
  resolution: ResolutionSummary | null,
): Faction[] {
  return world.factions.map((f) => ({
    ...f,
    internationalOpinion: updateInternationalOpinionForFaction(f, resolution),
  }))
}

/**
 * 兵变惩罚：给指定阵营的所有单位 morale -10（publicWill < 20 触发）。
 *
 * 由 turn-resolution 在 updatePublicWill 返回 crisisFactionIds 后调用，
 * 应用到 worldState.units（不可变产出）。
 *
 * @param world 当前世界状态（只读）
 * @param crisisFactionIds 触发兵变惩罚的阵营 id 列表
 * @returns 新 units 数组（morale -10，下限 0）
 */
export function applyMutinyPenalty(
  world: WorldState,
  crisisFactionIds: readonly string[],
): WorldState['units'] {
  if (crisisFactionIds.length === 0) return world.units
  const crisisSet = new Set(crisisFactionIds)
  return world.units.map((u) => {
    if (!crisisSet.has(u.factionId)) return u
    return { ...u, morale: Math.max(0, u.morale - 10) }
  })
}

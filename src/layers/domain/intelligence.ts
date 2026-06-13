/**
 * 情报衰减（intelligence.ts）— 纯函数。
 *
 * 情报四级（数大=清晰）：
 * - L0 盲区 / L1 热力脉冲 / L2 编制确认 / L3 全量透视
 *
 * 半衰期草案：halfLifeTurns=3，recon 命中刷新 lastSeenTurn，
 * 超过半衰期降级并显示残影 + [T-Nh] 标记。
 *
 * 全纯函数。`applyIntelDecay(worldState, currentTurn)` 遍历所有单位的 detection，
 * 按半衰规则降级 stale 的观测，刷新 staleTurns 残影标记。
 *
 * @module layers/domain/intelligence
 */

import type { WorldState, IntelLevel, IntelObservation, Unit } from '@/types'

/**
 * 单次情报级别衰减计算（底层原语）。
 *
 * 数值假设（PRD 草案）：
 * - halfLifeTurns=3：每过 3 个回合，情报降 decayPerHalfLife 级（默认 1）。
 * - 例：L3 在第 3 回合后 → L2，第 6 回合后 → L1，第 9 回合后 → L0（盲区）。
 * - staleTurns=0（刚侦察）不降级。
 *
 * @param level 当前级别
 * @param staleTurns 距上次侦察的回合数
 * @param halfLifeTurns 半衰回合数（默认 3）
 * @param decayPerHalfLife 每半衰降级数（默认 1）
 * @returns 衰减后级别（>=0）
 */
export function decayIntel(
  level: IntelLevel,
  staleTurns: number,
  halfLifeTurns = 3,
  decayPerHalfLife = 1,
): IntelLevel {
  if (staleTurns <= 0) return level
  const halfLivesPassed = Math.floor(staleTurns / halfLifeTurns)
  if (halfLivesPassed <= 0) return level
  const decayed = (level as number) - decayPerHalfLife * halfLivesPassed
  return Math.max(0, decayed) as IntelLevel
}

/**
 * 判定某观测是否需要显示残影（stale，超过半衰）。
 */
export function isStale(
  staleTurns: number,
  halfLifeTurns = 3,
): boolean {
  return staleTurns >= halfLifeTurns
}

/**
 * 残影标记回合数（T-Nh 中的 N）：超过半衰几倍。
 *
 * @returns 0 表示无残影；>=1 表示残影倍数
 */
export function staleGhostTurns(staleTurns: number, halfLifeTurns = 3): number {
  if (staleTurns < halfLifeTurns) return 0
  return Math.floor(staleTurns / halfLifeTurns)
}

/**
 * 单个观测记录的衰减更新（不可变产出）。
 *
 * 注意：本函数不修改原观测，返回更新后的 level/staleTurns。
 * recon 命中（lastSeenTurn == currentTurn）时不衰减（视为刚刷新）。
 *
 * @param observation 原观测记录
 * @param currentTurn 当前回合
 * @param halfLifeTurns 半衰回合（默认 3）
 * @param decayPerHalfLife 每半衰降级数（默认 1）
 */
export function decayObservation(
  observation: IntelObservation,
  currentTurn: number,
  halfLifeTurns = 3,
  decayPerHalfLife = 1,
): IntelObservation {
  const staleTurns = Math.max(0, currentTurn - observation.lastSeenTurn)
  // 刚侦察命中（staleTurns==0）保持级别；否则衰减
  const newLevel =
    staleTurns === 0
      ? observation.level
      : decayIntel(observation.level, staleTurns, halfLifeTurns, decayPerHalfLife)
  return {
    ...observation,
    level: newLevel,
    staleTurns,
  }
}

/**
 * 应用情报衰减到整个世界状态（纯函数）。
 *
 * 遍历所有单位的所有观测记录，按半衰规则降级 stale 观测并刷新残影标记。
 * 己方单位（observerFactionId == unit.factionId）保持 L3 全量透视不衰减。
 *
 * @param worldState 当前世界状态（只读）
 * @param currentTurn 当前回合索引（默认取 worldState.turnIndex）
 * @returns 新的单位数组（detection 已更新；不可变产出）
 */
export function applyIntelDecay(
  worldState: WorldState,
  currentTurn: number = worldState.turnIndex,
): Unit[] {
  const halfLifeTurns = worldState.intel.decayRule.halfLifeTurns
  const decayPerHalfLife = worldState.intel.decayRule.decayPerHalfLife

  return worldState.units.map((unit) => {
    const newDetection: Record<string, IntelObservation> = {}
    for (const [observerFactionId, observation] of Object.entries(unit.detection)) {
      // 己方对己方单位：保持全量透视（L3），不衰减
      if (observerFactionId === unit.factionId) {
        newDetection[observerFactionId] = {
          ...observation,
          level: 3 as IntelLevel,
          staleTurns: 0,
        }
        continue
      }
      newDetection[observerFactionId] = decayObservation(
        observation,
        currentTurn,
        halfLifeTurns,
        decayPerHalfLife,
      )
    }
    return { ...unit, detection: newDetection }
  })
}

/**
 * recon 行动命中：刷新某单位被某方观测的 lastSeenTurn（并升一级情报）。
 *
 * 纯函数，返回更新后的单个观测记录。
 *
 * @param observation 原观测记录
 * @param currentTurn 命中回合
 * @param gainedLevel 本次侦察获得的情报级别（一般 >= 当前级别）
 */
export function refreshOnRecon(
  observation: IntelObservation,
  currentTurn: number,
  gainedLevel: IntelLevel,
): IntelObservation {
  const newLevel = Math.max(observation.level, gainedLevel) as IntelLevel
  return {
    ...observation,
    level: newLevel,
    lastSeenTurn: currentTurn,
    staleTurns: 0,
  }
}

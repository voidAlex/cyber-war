/**
 * 导弹拦截（missile-defense.ts）— 纯函数。
 *
 * T2 第 5 批 A：导弹攻击的防空拦截判定。
 *
 * 设计（重写计划「第 5 批 A」）：
 * - resolveMissileAttack：当攻方为 missile 类型时，若守方阵营在目标范围内有 air-defense
 *   单位（equipment.sam 或类似拦截装备），按 interceptionProb 判定是否拦截成功。
 * - 拦截成功 → damage=0 + intercepted=true；失败 → damage=40（导弹高伤害）。
 * - interceptionProb = quality × 0.3 + count × 0.1（quality 0..1，count 为拦截弹数量）。
 *
 * 全纯函数，随机数由调用方注入 DeterministicRandom（确定性根）。
 *
 * @module layers/domain/missile-defense
 */

import type { WorldState, Unit, EquipmentSlot } from '@/types'
import type { DeterministicRandom } from './deterministic-random'

/** 拦截成功的导弹伤害（拦截后 damage=0，未拦截 damage=此常量）。 */
export const MISSILE_BASE_DAMAGE = 40

/**
 * 判定某单位是否具备防空拦截能力（equipment.sam 或类似拦截装备）。
 *
 * 拦截装备识别：equipment.type 含 'sam'/'intercept'/'bavar'/'patriot'/'thaad'/'aegis'
 * 任一关键字（兼容各战役包命名：S-300(sam) / Bavar-373(bavar) / 爱国者(patriot) /
 * 萨德(thaad) / 宙斯盾(aegis)）。
 *
 * @param unit 待检测单位
 * @returns 拦截能力信息 { quality, count } 或 null（无拦截能力）
 */
export function getAirDefenseCapability(
  unit: Unit,
): { quality: number; count: number } | null {
  const slots = unit.equipment
  if (!slots || slots.length === 0) return null
  // 累计所有拦截装备的总品质/数量（取加权品质平均 + 总数）
  let totalQuality = 0
  let totalCount = 0
  let weightSum = 0
  for (const slot of slots) {
    if (!isInterceptorEquipment(slot)) continue
    totalQuality += slot.quality * slot.count
    weightSum += slot.count
    totalCount += slot.count
  }
  if (totalCount <= 0) return null
  return {
    quality: totalQuality / weightSum, // 加权平均品质
    count: totalCount,
  }
}

/**
 * 判定某装备槽是否为拦截装备（防空/反导）。
 *
 * 关键字匹配（兼容各战役包命名）：
 * - sam（通用防空导弹，S-300/爱国者前缀常用）
 * - intercept / interception（反导拦截）
 * - bavar（伊朗 Bavar-373）
 * - patriot（爱国者）
 * - thaad（萨德）
 * - aegis（宙斯盾，舰载反导）
 */
function isInterceptorEquipment(slot: EquipmentSlot): boolean {
  const t = slot.type.toLowerCase()
  return (
    t.includes('sam') ||
    t.includes('intercept') ||
    t.includes('bavar') ||
    t.includes('patriot') ||
    t.includes('thaad') ||
    t.includes('aegis')
  )
}

/**
 * 在目标单位所在 cell 周围（曼哈顿距离 ≤ range）查找守方阵营的防空拦截单位。
 *
 * 不伪造：仅基于真实 world.units。返回最具拦截能力的单位（interceptionProb 最高）。
 *
 * @param world 当前世界状态
 * @param targetCoord 目标坐标
 * @param defenderFactionId 守方阵营 id（拦截方）
 * @param range 拦截覆盖半径（曼哈顿距离，默认 3 格）
 * @returns 最强拦截单位 + 其能力，或 null（无可拦截单位）
 */
export function findBestAirDefender(
  world: WorldState,
  targetCoord: { col: number; row: number },
  defenderFactionId: string,
  range = 3,
): { unit: Unit; capability: { quality: number; count: number } } | null {
  let best:
    | { unit: Unit; capability: { quality: number; count: number } }
    | null = null
  let bestProb = -1

  for (const unit of world.units) {
    if (unit.factionId !== defenderFactionId) continue
    if (unit.strength <= 0) continue
    const dist =
      Math.abs(unit.coord.col - targetCoord.col) +
      Math.abs(unit.coord.row - targetCoord.row)
    if (dist > range) continue

    const cap = getAirDefenseCapability(unit)
    if (!cap) continue

    const prob = computeInterceptionProb(cap.quality, cap.count)
    if (prob > bestProb) {
      bestProb = prob
      best = { unit, capability: cap }
    }
  }

  return best
}

/**
 * 计算拦截概率（重写计划「第 5 批 A」公式）。
 *
 * interceptionProb = quality × 0.3 + count × 0.1，封顶 0.95（保留 5% 突防概率）。
 *
 * @param quality 拦截装备加权平均品质（0..1）
 * @param count 拦截弹数量
 * @returns 拦截概率 0..0.95
 */
export function computeInterceptionProb(
  quality: number,
  count: number,
): number {
  const raw = quality * 0.3 + count * 0.1
  return Math.max(0, Math.min(0.95, raw))
}

/**
 * resolveMissileAttack 返回结构。
 */
export interface MissileAttackResult {
  /** 是否被拦截（true=拦截成功 damage=0） */
  intercepted: boolean
  /** 目标承受的伤害（拦截成功=0；失败=MISSILE_BASE_DAMAGE） */
  damage: number
  /** 执行拦截的防空单位（拦截成功时填充；无拦截/失败时为 null） */
  interceptorUnit: Unit | null
  /** 拦截概率（0..0.95，无拦截单位时为 0） */
  interceptionProb: number
}

/**
 * 结算一次导弹攻击（含防空拦截判定）。
 *
 * 流程（重写计划「第 5 批 A」）：
 * 1. 在目标单位所在 cell 周围（半径默认 3）查找守方阵营的防空拦截单位。
 * 2. 取最强拦截单位的 quality/count 计算 interceptionProb。
 * 3. rng.nextFloat() < interceptionProb → 拦截成功 damage=0；否则 damage=MISSILE_BASE_DAMAGE。
 * 4. 无拦截单位 → interceptionProb=0，必然命中 damage=MISSILE_BASE_DAMAGE。
 *
 * 确定性：随机数由调用方注入 DeterministicRandom（scenarioSeed:turn:sequence）。
 *
 * @param target 攻击目标单位
 * @param defenderFactionId 守方阵营 id（拦截方）
 * @param world 当前世界状态（用于查防空单位）
 * @param rng 注入的确定性随机
 * @param range 拦截覆盖半径（默认 3）
 * @returns MissileAttackResult（intercepted + damage + interceptorUnit + interceptionProb）
 */
export function resolveMissileAttack(
  target: Unit,
  defenderFactionId: string,
  world: WorldState,
  rng: DeterministicRandom,
  range = 3,
): MissileAttackResult {
  const defender = findBestAirDefender(
    world,
    target.coord,
    defenderFactionId,
    range,
  )

  if (!defender) {
    // 无防空单位 → 必然命中
    return {
      intercepted: false,
      damage: MISSILE_BASE_DAMAGE,
      interceptorUnit: null,
      interceptionProb: 0,
    }
  }

  const prob = computeInterceptionProb(
    defender.capability.quality,
    defender.capability.count,
  )
  const roll = rng.nextFloat()
  const intercepted = roll < prob

  return {
    intercepted,
    damage: intercepted ? 0 : MISSILE_BASE_DAMAGE,
    interceptorUnit: defender.unit,
    interceptionProb: prob,
  }
}

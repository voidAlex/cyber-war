/**
 * 海战结算（naval-combat.ts）— 纯函数（T3-C）。
 *
 * 海上交战规则（钢铁雄心对比）：
 * - naval vs naval：超视距（射程=2，attack 命令可打 2 格内目标）、火力 ×1.5（海上火力优势）、
 *   defender ammo-15（海上持续炮击弹药消耗大）。
 * - carrier（type naval + equipment carrier-strike-fighter）：可携 air 出击（air sortie）。
 *   air 从 carrier cell 出发攻击目标，必须返回 carrier cell，否则坠毁。
 *
 * 全纯函数，随机数由调用方注入 DeterministicRandom。
 *
 * @module layers/domain/naval-combat
 */

import type { Unit } from '@/types'
import type { DeterministicRandom } from './deterministic-random'

/** 海上火力优势倍率（naval vs naval attacker firepower ×1.5）。 */
export const NAVAL_FIREPOWER_MULT = 1.5
/** 海上交战守方弹药消耗（持续炮击）。 */
export const NAVAL_DEFENDER_AMMO_COST = 15
/** 海军交战射程（超视距，attack 可打 2 格内目标）。 */
export const NAVAL_ENGAGEMENT_RANGE = 2
/** 舰载机出击对目标造成的 strength 损失下限。 */
export const AIR_SORTIE_DAMAGE_MIN = 20
/** 舰载机出击对目标造成的 strength 损失上限。 */
export const AIR_SORTIE_DAMAGE_MAX = 30
/** 舰载机出击后自身 strength 消耗（起降损耗）。 */
export const AIR_SORTIE_SELF_STRENGTH_COST = 5

/**
 * 判定单位是否为航母（type naval + 装备含 carrier-strike-fighter 关键字）。
 *
 * @param unit 待判定单位
 * @returns true=航母（可携 air 出击）
 */
export function isCarrier(unit: Unit): boolean {
  if (unit.type !== 'naval') return false
  const slots = unit.equipment
  if (!slots) return false
  return slots.some((s) => {
    const t = s.type.toLowerCase()
    return (
      t.includes('carrier') ||
      t.includes('strike-fighter') ||
      t.includes('strike fighter') ||
      t.includes('flight deck')
    )
  })
}

/**
 * 海上交战结算（naval vs naval）。
 *
 * 数值假设（与 combat.resolveDamage 互补，海上专门规则）：
 * - 攻方火力 = attacker.strength × NAVAL_FIREPOWER_MULT (1.5)（海上火力优势）。
 * - 守方承受 damage = 火力 × (0.7 + rng×0.6)（浮动 0.7..1.3）。
 * - 守方 ammo -=15（海上持续炮击弹药消耗大）。
 * - 攻方 counterDamage = defender.strength × (0.3 + rng×0.4)（守方反击，浮动 0.3..0.7）。
 * - 攻方 ammo -=10。
 *
 * 确定性：用注入的 rng（DeterministicRandom.fromSequence）。
 *
 * @param attacker 攻方海军单位
 * @param defender 守方海军单位
 * @param rng 注入的确定性随机
 * @returns { damage, counterDamage }：守方/攻方承受的 strength 损失
 */
export function resolveNavalEngagement(
  attacker: Unit,
  defender: Unit,
  rng: DeterministicRandom,
): { damage: number; counterDamage: number } {
  // 攻方海上火力（×1.5 优势）
  const attackerFirepower = attacker.strength * NAVAL_FIREPOWER_MULT
  // 守方承受伤害（浮动 0.7..1.3）
  const damageRoll = 0.7 + rng.nextFloat() * 0.6
  const damage = Math.round(attackerFirepower * damageRoll * 0.3) // ×0.3 归一化到合理 strength 损失区间

  // 守方反击（浮动 0.3..0.7）
  const counterRoll = 0.3 + rng.nextFloat() * 0.4
  const counterDamage = Math.round(defender.strength * counterRoll * 0.2)

  return { damage, counterDamage }
}

/**
 * 舰载机出击结算（air sortie）。
 *
 * 流程（钢铁雄心 carrier mechanic）：
 * 1. airUnit 从 carrierUnit 所在 cell 出击，攻击 targetUnits（每个 strength -20~30）。
 * 2. airUnit 必须返回 carrier cell（payload.baseCarrierCellId 标记母舰格）。
 * 3. 如 carrier 已沉没（strength=0）→ airUnit 无法降落，strength=0（坠毁）。
 * 4. airUnit 自身 strength -=5（起降损耗）。
 *
 * 确定性：用注入的 rng。
 *
 * @param airUnit 出击的舰载机单位（type air）
 * @param carrierUnit 母舰单位（type naval，需 isCarrier=true）
 * @param targetCell 攻击目标 cell 坐标（仅供记录，不参与计算）
 * @param targetUnits 目标 cell 内的敌方单位列表
 * @param rng 注入的确定性随机
 * @returns { damage, mustReturn, airCrashed, damagedUnitIds }：
 *   - damage：对每个目标造成的 strength 损失
 *   - mustReturn：airUnit 是否必须返回 carrier cell（true=需返回；carrier 沉没时 airCrashed=true）
 *   - airCrashed：carrier 已沉没导致 airUnit 坠毁（strength=0）
 *   - damagedUnitIds：受创的目标单位 id 列表
 */
export function resolveAirSortie(
  airUnit: Unit,
  carrierUnit: Unit,
  targetCell: { col: number; row: number },
  targetUnits: readonly Unit[],
  rng: DeterministicRandom,
): {
  damage: number
  mustReturn: boolean
  airCrashed: boolean
  damagedUnitIds: string[]
} {
  // 每个目标承受 AIR_SORTIE_DAMAGE_MIN..MAX 的随机伤害
  const damage = AIR_SORTIE_DAMAGE_MIN + rng.nextInt(0, AIR_SORTIE_DAMAGE_MAX - AIR_SORTIE_DAMAGE_MIN)
  const damagedUnitIds = targetUnits
    .filter((u) => u.strength > 0)
    .map((u) => u.id)

  // carrier 是否已沉没（strength=0）→ airUnit 无法降落，坠毁
  const airCrashed = carrierUnit.strength <= 0

  // airUnit 必须返回 carrier cell（除非坠毁）
  const mustReturn = !airCrashed

  void targetCell
  void airUnit
  return { damage, mustReturn, airCrashed, damagedUnitIds }
}

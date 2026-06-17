/**
 * 空战结算（air-combat.ts）— 纯函数（T3-C）。
 *
 * 制空权争夺（钢铁雄心对比）：
 * - air vs air：双方比较 firepower × morale × rng，胜方获侦察加成（reconnaissance bonus，
 *   +1 level，模拟制空权带来的侦察优势）。
 * - 败方 morale-10 + strength-15。
 *
 * 全纯函数，随机数由调用方注入 DeterministicRandom。
 *
 * @module layers/domain/air-combat
 */

import type { Unit } from '@/types'
import type { DeterministicRandom } from './deterministic-random'

/** 制空权争夺中败方的 morale 惩罚。 */
export const AIR_SUPERIORITY_LOSER_MORALE_PENALTY = 10
/** 制空权争夺中败方的 strength 损失。 */
export const AIR_SUPERIORITY_LOSER_STRENGTH_PENALTY = 15
/** 制空权争夺胜方获得的侦察加成（+N level，封顶 L3）。 */
export const AIR_SUPERIORITY_WINNER_RECON_BONUS = 1

/**
 * 制空权争夺结算（air vs air）。
 *
 * 流程：
 * 1. 双方各算"空战分"= firepower × morale × rng（firepower≈strength，morale 归一化到 0..1）。
 * 2. 分高者为 winner，分低者为 loser。
 * 3. winner 获 reconnaissance bonus（+1 level，封顶 L3）—— 模拟制空权带来的侦察优势。
 * 4. loser morale-10 + strength-15。
 *
 * 平局处理：rng 完全相等时（极罕见），按 attacker 为 winner（攻方主动性优势）。
 *
 * 确定性：用注入的 rng。
 *
 * @param airAttacker 攻方空军单位（type air）
 * @param airDefender 守方空军单位（type air）
 * @param rng 注入的确定性随机
 * @returns { winner, loserBonus, loserMoralePenalty, loserStrengthPenalty }：
 *   - winner：胜方单位 id
 *   - loserBonus：胜方获得的侦察加成（+1 level，封顶 L3）
 *   - loserMoralePenalty：败方 morale 惩罚量（-10）
 *   - loserStrengthPenalty：败方 strength 损失量（-15）
 */
export function resolveAirSuperiority(
  airAttacker: Unit,
  airDefender: Unit,
  rng: DeterministicRandom,
): {
  winner: string
  loser: string
  loserBonus: number
  loserMoralePenalty: number
  loserStrengthPenalty: number
} {
  // 空战分：firepower(strength) × morale(归一化 0..1) × rng(0.5..1.5)
  const attackerScore = airAttacker.strength * (airAttacker.morale / 100) * (0.5 + rng.nextFloat())
  const defenderScore = airDefender.strength * (airDefender.morale / 100) * (0.5 + rng.nextFloat())

  // 平局时攻方为 winner（攻方主动性优势）
  const attackerWins = attackerScore >= defenderScore
  const winner = attackerWins ? airAttacker.id : airDefender.id
  const loser = attackerWins ? airDefender.id : airAttacker.id

  return {
    winner,
    loser,
    loserBonus: AIR_SUPERIORITY_WINNER_RECON_BONUS,
    loserMoralePenalty: AIR_SUPERIORITY_LOSER_MORALE_PENALTY,
    loserStrengthPenalty: AIR_SUPERIORITY_LOSER_STRENGTH_PENALTY,
  }
}

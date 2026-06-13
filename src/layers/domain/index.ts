/**
 * 领域层 barrel — 全纯函数（铁律边界）。
 *
 * combat / intelligence / diplomacy / physics-rules / victory 均为纯函数，
 * vitest import 时不得拉起任何 Tauri/fetch/crypto，不调 Date.now()/随机数。
 *
 * @module layers/domain
 */

export { resolveCombat } from './combat'
export type { CombatInput } from './combat'
export { decayIntel } from './intelligence'
export { applyTrustChange } from './diplomacy'
export { applyPhysicsRules } from './physics-rules'
export { checkVictory } from './victory'
export type { VictoryResult } from './victory'

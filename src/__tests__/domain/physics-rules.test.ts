/**
 * 物理规则（physics-rules）单测。
 *
 * 验证各数值公式：有效火力/防御、机动（地形受阻/燃料）、补给消耗、战损结算。
 * 随机数注入固定 seed 的 DeterministicRandom，保证可复现。
 *
 * @module __tests__/domain/physics-rules
 */

import { describe, expect, it } from 'vitest'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import {
  resolveDamage,
  resolveMovement,
  computeBaselineConsumption,
  applyResupply,
  computeEffectiveFirepower,
  computeEffectiveDefense,
  computeMoraleLoss,
  isAnnihilated,
  isLowSupply,
  getCellAt,
  FIREPOWER_RATIO,
  FIREPOWER_MULT_BY_TYPE,
  DEFENSE_MULT_BY_TYPE,
  FORTRESS_UNIT_DEFENSE_BONUS,
  LOW_MORALE_THRESHOLD,
  HIGH_FATIGUE_THRESHOLD,
  LOW_MORALE_FIREPOWER_MULT,
  HIGH_FATIGUE_DEFENSE_MULT,
  FUEL_PER_CELL_MOVED,
  AMMO_PER_ENGAGEMENT,
  RESUPPLY_AMOUNT,
  MAX_STRENGTH_LOSS_PER_ENGAGEMENT,
} from '@/layers/domain/physics-rules'
import type { Unit, MapCell } from '@/types'

/** 构造最小合法 Unit（默认满状态步兵） */
function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    factionId: 'blue',
    type: 'infantry',
    coord: { col: 0, row: 0 },
    strength: 100,
    personnel: 1000,
    maxPersonnel: 1000,
    fuel: 100,
    ammo: 100,
    morale: 80,
    fatigue: 0,
    detection: {},
    orders: [],
    status: [],
    ...overrides,
  }
}

/** 构造地图单元 */
function makeCell(overrides: Partial<MapCell> = {}): MapCell {
  return {
    id: '0:0',
    col: 0,
    row: 0,
    terrain: 'plain',
    movementCost: 1,
    defenseBonus: 0,
    isObjective: false,
    ...overrides,
  }
}

describe('getCellAt', () => {
  it('按行优先索引取单元', () => {
    const cells = [
      makeCell({ id: '0:0', col: 0, row: 0 }),
      makeCell({ id: '1:0', col: 1, row: 0 }),
      makeCell({ id: '0:1', col: 0, row: 1 }),
    ]
    expect(getCellAt({ cols: 2, cells }, 1, 0)?.id).toBe('1:0')
    expect(getCellAt({ cols: 2, cells }, 0, 1)?.id).toBe('0:1')
  })

  it('越界返回 null', () => {
    expect(getCellAt({ cols: 2, cells: [] }, -1, 0)).toBeNull()
    expect(getCellAt({ cols: 2, cells: [] }, 0, -1)).toBeNull()
    expect(getCellAt({ cols: 0, cells: [] }, 0, 0)).toBeNull()
  })
})

describe('computeEffectiveFirepower', () => {
  it('满状态步兵 = strength * 火力系数', () => {
    const u = makeUnit({ strength: 100, ammo: 100, morale: 80 })
    const fp = computeEffectiveFirepower(u)
    expect(fp).toBeCloseTo(100 * 1 * FIREPOWER_MULT_BY_TYPE.infantry * FIREPOWER_RATIO, 5)
  })

  it('弹药不足削弱火力（按 ammo/100）', () => {
    const u = makeUnit({ ammo: 50 })
    const fpFull = computeEffectiveFirepower(makeUnit({ ammo: 100 }))
    const fpHalf = computeEffectiveFirepower(u)
    expect(fpHalf).toBeCloseTo(fpFull * 0.5, 5)
  })

  it('低士气削弱火力', () => {
    const u = makeUnit({ morale: LOW_MORALE_THRESHOLD - 5 })
    const fpNormal = computeEffectiveFirepower(makeUnit({ morale: 80 }))
    expect(computeEffectiveFirepower(u)).toBeCloseTo(fpNormal * LOW_MORALE_FIREPOWER_MULT, 5)
  })

  it('炮兵火力乘数高于步兵', () => {
    const inf = computeEffectiveFirepower(makeUnit({ type: 'infantry' }))
    const art = computeEffectiveFirepower(makeUnit({ type: 'artillery' }))
    expect(art / inf).toBeCloseTo(FIREPOWER_MULT_BY_TYPE.artillery, 5)
  })
})

describe('computeEffectiveDefense', () => {
  it('地形 defenseBonus 增加防御', () => {
    const cell = makeCell({ defenseBonus: 0.5 })
    const plain = makeCell({ defenseBonus: 0 })
    const u = makeUnit()
    expect(computeEffectiveDefense(u, cell)).toBeGreaterThan(computeEffectiveDefense(u, plain))
  })

  it('要塞单位额外加成', () => {
    const fortress = makeUnit({ type: 'fortress' })
    const cell = makeCell({ defenseBonus: 0 })
    const def = computeEffectiveDefense(fortress, cell)
    // strength * fortress_mult * 1 * (1 + FORTRESS_UNIT_DEFENSE_BONUS)
    expect(def).toBeCloseTo(
      100 * DEFENSE_MULT_BY_TYPE.fortress * 1 * (1 + FORTRESS_UNIT_DEFENSE_BONUS),
      5,
    )
  })

  it('高疲劳削弱防御', () => {
    const cell = makeCell()
    const rested = computeEffectiveDefense(makeUnit({ fatigue: 0 }), cell)
    const tired = computeEffectiveDefense(
      makeUnit({ fatigue: HIGH_FATIGUE_THRESHOLD + 10 }),
      cell,
    )
    expect(tired).toBeCloseTo(rested * HIGH_FATIGUE_DEFENSE_MULT, 5)
  })
})

describe('resolveMovement', () => {
  it('燃料充足 + 平原 → 成功', () => {
    const rng = new DeterministicRandom('move-ok')
    const unit = makeUnit({ fuel: 100 })
    const cell = makeCell({ movementCost: 1 })
    const result = resolveMovement({ unit, targetCell: cell, cellsToTraverse: 3, rng })
    expect(result.success).toBe(true)
    expect(result.fuelCost).toBe(FUEL_PER_CELL_MOVED * 3 * 1)
  })

  it('燃料不足 → 失败并耗尽剩余', () => {
    const rng = new DeterministicRandom('move-nofuel')
    const unit = makeUnit({ fuel: 5 })
    const cell = makeCell({ movementCost: 1 })
    const result = resolveMovement({ unit, targetCell: cell, cellsToTraverse: 5, rng })
    expect(result.success).toBe(false)
    expect(result.fuelCost).toBe(5)
    expect(result.reason).toContain('燃料不足')
  })

  it('高 movementCost 地形有受阻概率', () => {
    // 用极多单位重复采样受阻概率
    let blocked = 0
    const N = 1000
    for (let i = 0; i < N; i++) {
      const rng = new DeterministicRandom(`move-block-${i}`)
      const unit = makeUnit({ fuel: 100 })
      const cell = makeCell({ movementCost: 6 }) // 受阻概率 ~0.5
      const result = resolveMovement({ unit, targetCell: cell, cellsToTraverse: 1, rng })
      if (!result.success && result.reason?.includes('受阻')) blocked++
    }
    // movementCost=6 → blockChance=0.5，允许 ±10%
    const ratio = blocked / N
    expect(ratio).toBeGreaterThan(0.4)
    expect(ratio).toBeLessThan(0.6)
  })

  it('movementCost=1 时不会因地形受阻', () => {
    const rng = new DeterministicRandom('move-plain')
    const unit = makeUnit({ fuel: 100 })
    const cell = makeCell({ movementCost: 1 })
    const result = resolveMovement({ unit, targetCell: cell, cellsToTraverse: 2, rng })
    expect(result.success).toBe(true)
  })
})

describe('resolveDamage', () => {
  it('攻强守弱 → 攻方造成正伤害', () => {
    const rng = new DeterministicRandom('dmg-win')
    const attacker = makeUnit({ id: 'att', strength: 100, ammo: 100, morale: 80 })
    const defender = makeUnit({ id: 'def', strength: 20, ammo: 100, morale: 50 })
    const cell = makeCell({ defenseBonus: 0 })
    const dmg = resolveDamage({ attacker, defender, defenderCell: cell, rng })
    expect(dmg.attackerDealt).toBeGreaterThan(0)
  })

  it('守方防御远超攻方火力 → 攻方净伤害为 0', () => {
    const rng = new DeterministicRandom('dmg-blocked')
    const attacker = makeUnit({ strength: 10, ammo: 100, morale: 80 })
    const defender = makeUnit({ type: 'fortress', strength: 100, ammo: 100, morale: 80 })
    const cell = makeCell({ defenseBonus: 0.5 })
    const dmg = resolveDamage({ attacker, defender, defenderCell: cell, rng })
    expect(dmg.attackerDealt).toBe(0)
  })

  it('单次交战 strength 损失不超过上限', () => {
    const rng = new DeterministicRandom('dmg-cap')
    // 极强攻方 vs 极弱守方
    const attacker = makeUnit({ type: 'artillery', strength: 100, ammo: 100, morale: 100 })
    const defender = makeUnit({ strength: 1, ammo: 0, morale: 0, fatigue: 100 })
    const cell = makeCell({ defenseBonus: 0 })
    const dmg = resolveDamage({ attacker, defender, defenderCell: cell, rng })
    expect(dmg.attackerDealt).toBeLessThanOrEqual(MAX_STRENGTH_LOSS_PER_ENGAGEMENT)
  })

  it('守方被压制时反击削弱', () => {
    const rngA = new DeterministicRandom('dmg-suppressed')
    const rngB = new DeterministicRandom('dmg-suppressed')
    const attacker = makeUnit({ strength: 50, ammo: 100, morale: 80 })
    const defenderNormal = makeUnit({ strength: 50, ammo: 100, morale: 80, status: [] })
    const defenderSupp = makeUnit({ strength: 50, ammo: 100, morale: 80, status: ['suppressed'] })
    const cell = makeCell()
    const normal = resolveDamage({ attacker, defender: defenderNormal, defenderCell: cell, rng: rngA })
    const supp = resolveDamage({ attacker, defender: defenderSupp, defenderCell: cell, rng: rngB })
    expect(supp.defenderDealt).toBeLessThanOrEqual(normal.defenderDealt)
  })

  it('相同输入两次结算完全一致（确定性）', () => {
    const mk = () => {
      const rng = new DeterministicRandom('dmg-determ')
      return resolveDamage({
        attacker: makeUnit({ strength: 70 }),
        defender: makeUnit({ strength: 60 }),
        defenderCell: makeCell({ defenseBonus: 0.2 }),
        rng,
      })
    }
    expect(mk()).toEqual(mk())
  })
})

describe('补给与消耗', () => {
  it('computeBaselineConsumption 扣基线 fuel/ammo', () => {
    const u = makeUnit({ orders: [] })
    const c = computeBaselineConsumption(u)
    expect(c.fuelCost).toBeGreaterThan(0)
    expect(c.ammoCost).toBeGreaterThan(0)
    expect(c.fatigueDelta).toBeLessThan(0) // 无命令单位恢复
  })

  it('有命令单位基线不恢复疲劳', () => {
    const u = makeUnit({ orders: ['order-1'] })
    const c = computeBaselineConsumption(u)
    expect(c.fatigueDelta).toBe(0)
  })

  it('applyResupply 恢复 fuel/ammo 不超过 100', () => {
    const low = makeUnit({ fuel: 50, ammo: 50 })
    const r = applyResupply(low)
    expect(r.fuel).toBe(50 + RESUPPLY_AMOUNT)
    expect(r.ammo).toBe(50 + RESUPPLY_AMOUNT)

    const high = makeUnit({ fuel: 95, ammo: 95 })
    const r2 = applyResupply(high)
    expect(r2.fuel).toBe(100)
    expect(r2.ammo).toBe(100)
  })

  it('AMMO_PER_ENGAGEMENT 为正值', () => {
    expect(AMMO_PER_ENGAGEMENT).toBeGreaterThan(0)
  })
})

describe('士气/状态衍生', () => {
  it('computeMoraleLoss 按 strength 损失比例', () => {
    expect(computeMoraleLoss(20)).toBeGreaterThan(computeMoraleLoss(5))
  })

  it('isAnnihilated：strength<=0 为 true', () => {
    expect(isAnnihilated(makeUnit({ strength: 0 }))).toBe(true)
    expect(isAnnihilated(makeUnit({ strength: 1 }))).toBe(false)
  })

  it('isLowSupply：fuel 或 ammo 低即为 true', () => {
    expect(isLowSupply(makeUnit({ fuel: 5, ammo: 100 }))).toBe(true)
    expect(isLowSupply(makeUnit({ fuel: 100, ammo: 5 }))).toBe(true)
    expect(isLowSupply(makeUnit({ fuel: 100, ammo: 100 }))).toBe(false)
  })
})

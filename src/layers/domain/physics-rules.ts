/**
 * 物理规则（physics-rules.ts）— 纯数值结算公式。
 *
 * 数值骨架 + LLM 大自由（重写计划决策#6）：数值规则 = 物理真相，
 * 可回放、公平、可平衡；导演部（M3）可覆写但必须留痕。
 *
 * 全纯函数，随机数一律由调用方注入 DeterministicRandom（铁律）。
 *
 * === 数值设计假设摘要（M2 兵棋草案，凡尔登 1916 量级校准）===
 *
 * 1. 单位核心量纲：strength/personnel/fuel/ammo/morale/fatigue 均 0..100。
 * 2. 地形 movementCost：1（平原基准）..6（山地/沼泽）；defenseBonus：0（平原）
 *    ..0.5（要塞，含堡垒工事叠加）。凡尔登堡垒 defenseBonus 设 ~0.5 模拟绞肉机。
 * 3. 战损核心公式（Lanchester 线性律简化版）：
 *      攻方火力 = strength_attacker * (ammo/100) * 火力系数
 *      守方防御 = strength_defender * (1 + defenseBonus) * (1 + 要塞加成)
 *      净伤害 = max(0, 攻方火力 - 守方防御) * 命中随机扰动
 * 4. 士气/疲劳调制：morale<30 降低火力，fatigue>70 降低防御（消耗战体现）。
 * 5. 补给消耗：每回合基线 + 行动额外（机动耗油、交战耗弹）。
 *
 * 所有数值常量集中文件顶部，便于 M4 凡尔登包 rules.json 覆盖。
 *
 * @module layers/domain/physics-rules
 */

import type { Unit, MapCell, UnitType, EquipmentSlot } from '@/types'
import type { DeterministicRandom } from './deterministic-random'

// ============================================================================
// 数值常量（M2 草案，集中此处便于 rules.json 覆盖）
// ============================================================================

/** 火力系数：攻方单位强度转化为火力的基础比率 */
export const FIREPOWER_RATIO = 0.5

/** 命中随机扰动幅度（净伤害 ± x%，x=此值）——体现战场不确定性 */
export const DAMAGE_JITTER = 0.15

/** 单位类型对火力的乘数（装甲/炮兵火力更强） */
export const FIREPOWER_MULT_BY_TYPE: Record<UnitType, number> = {
  infantry: 1.0,
  armor: 1.4,
  artillery: 1.8,
  recon: 0.6,
  fortress: 1.2,
  support: 0.3,
  // 第 5 批陆海空导弹四域基础参数（精确调参后续 M5+）：
  air: 1.6, // 空军火力强（跨格打击，不受地形），但弹药/燃料消耗大
  naval: 1.5, // 海军舰炮火力强，仅水域可发挥
  missile: 2.5, // 导弹超远程一回合打击，单发火力极高（但弹药消耗巨大）
  // T2 第 2 批：电子战单位本身火力弱（非杀伤平台，靠干扰/支援影响 intel）。
  ew: 0.4,
}

/** 单位类型对防御的乘数（要塞/装甲更抗打） */
export const DEFENSE_MULT_BY_TYPE: Record<UnitType, number> = {
  infantry: 1.0,
  armor: 1.3,
  artillery: 0.7,
  recon: 0.6,
  fortress: 2.0,
  support: 0.8,
  // 第 5 批陆海空导弹四域基础参数：
  air: 0.4, // 空军防御弱（易被防空/拦截，靠机动规避而非装甲）
  naval: 1.1, // 海军装甲中等（舰体抗打但不如陆地要塞）
  missile: 0.3, // 导弹部队防御极弱（发射车无防护，靠射程免受反击）
  // T2 第 2 批：电子战单位防御弱（电子设备/天线无装甲，靠隐蔽/远离前线）。
  ew: 0.5,
}

/** 要塞类型单位额外防御加成（杜奥蒙堡等堡垒） */
export const FORTRESS_UNIT_DEFENSE_BONUS = 1.0

// ============================================================================
// T1-A：工事/战壕防御加成常量
// ============================================================================

/**
 * 单位 entrenchment（战壕等级）每级防御加成（T1-A）。
 *
 * computeEffectiveDefense 把 unit.entrenchment * ENTRENCHMENT_DEFENSE_PER_LEVEL
 * 作为独立乘法因子叠加（与地形 defenseBonus、要塞单位加成并列）。
 * 缺省 0 级无加成（兼容旧存档）。
 */
export const ENTRENCHMENT_DEFENSE_PER_LEVEL = 0.15

/**
 * 单元格 fortificationLevel（野战工事等级）每级防御加成（T1-A）。
 *
 * 与单位自身 entrenchment 区分：cell.fortificationLevel 是单位离开后
 * 仍残留在该格的工事（每回合 -1 衰减），任何单位进入此格都能吃到。
 * computeEffectiveDefense 把 cell.fortificationLevel * FORTIFICATION_CELL_DEFENSE_PER_LEVEL
 * 作为独立乘法因子叠加。
 */
export const FORTIFICATION_CELL_DEFENSE_PER_LEVEL = 0.1

// ============================================================================
// T1-C：日夜循环 modifier 常量（night 时生效）
// ============================================================================

/**
 * 夜战 modifier（T1-C，world.timeOfDay === 'night' 时生效）。
 *
 * - reconLevelPenalty：侦察获得的 intel level -1（最低 L0），体现夜间观测困难。
 * - fuelCostMult：机动燃料消耗倍率（夜行军困难，1.2）。
 * - attackMoralePenalty：被攻击方士气惩罚（夜间防御心理压力大，-5）。
 * - surpriseBonus：夜袭火力加成（chief 解析"夜袭"时，攻方 firepower +0.2 倍率）。
 *
 * physics.worker 在 resolveReconOrder/resolveMovementOrder/resolveAttackOrder 中
 * 读 world.timeOfDay 应用对应 modifier。
 */
export const NIGHT_MODIFIERS = {
  /** 侦察 intel level 降级（night 时 gainedLevel -1，最低 L0）。 */
  reconLevelPenalty: 1,
  /** 夜行军燃料消耗倍率。 */
  fuelCostMult: 1.2,
  /** 夜间被攻击方士气惩罚（负值，defender.morale + 此值）。 */
  attackMoralePenalty: -5,
  /** 夜袭火力加成倍率（攻方 firepower * (1 + surpriseBonus)）。 */
  surpriseBonus: 0.2,
} as const

// ============================================================================
// T1-D：溃退/投降默认阈值
// ============================================================================

/**
 * 溃退判定默认阈值（T1-D，rules.routThreshold 可覆盖）。
 *
 * - morale < ROUT_DEFAULT_MORALE_THRESHOLD（15）且 strength < ROUT_DEFAULT_STRENGTH_THRESHOLD（30）
 *   → 单位溃退（向己方补给源方向移 1 格 + status 'routed'）。
 * - morale < SURRENDER_DEFAULT_MORALE_THRESHOLD（5）且所有邻格被敌方包围 → 投降。
 */
export const ROUT_DEFAULT_MORALE_THRESHOLD = 15
export const ROUT_DEFAULT_STRENGTH_THRESHOLD = 30
export const SURRENDER_DEFAULT_MORALE_THRESHOLD = 5

// ============================================================================
// 第 5 批：装备配置 + 陆海空导弹特殊结算常量
// ============================================================================

/**
 * 装备火力加成基准（第 5 批）。
 *
 * computeEquipmentFirepowerBonus 把装备折算为火力加成倍率（叠加在类型乘数之后）：
 *   bonus = 1 + (Σ count_i * quality_i) / EQUIPMENT_FIREPOWER_DIVISOR * EQUIPMENT_FIREPOWER_GAIN
 * 即装备越多、品质越高，加成越大，但受 DIVISOR 抑制避免无限放大。
 */
export const EQUIPMENT_FIREPOWER_DIVISOR = 5000

/** 装备火力加成增益系数（满基准装备约 +0.5 火力倍率） */
export const EQUIPMENT_FIREPOWER_GAIN = 0.5

/**
 * 空军攻击是否忽略目标格地形防御加成（跨格打击，不受 movementCost/defenseBonus 影响）。
 *
 * resolveDamage 中 attacker.type==='air' 时跳过 defenderCell.defenseBonus 折算。
 */
export const AIR_IGNORES_TERRAIN_DEFENSE = true

/**
 * 海军是否仅能在水域发挥完整火力（非水域 firepower 折半）。
 *
 * 由调用方据 cell.terrain 判定后传入 navalPenalty；此处仅暴露阈值语义。
 */
export const NAVAL_OFFWATER_FIREPOWER_MULT = 0.5

/**
 * 导弹单次攻击弹药消耗（超远程一回合打击的代价）。
 *
 * 交战时 attacker.type==='missile' 额外扣此弹药（替代 AMMO_PER_ENGAGEMENT）。
 */
export const MISSILE_AMMO_PER_ENGAGEMENT = 40

/** 士气低于此阈值降低火力 */
export const LOW_MORALE_THRESHOLD = 30

/** 士气低落时的火力乘数 */
export const LOW_MORALE_FIREPOWER_MULT = 0.6

/** 疲劳高于此阈值降低防御（消耗战体现） */
export const HIGH_FATIGUE_THRESHOLD = 70

/** 高疲劳时的防御乘数 */
export const HIGH_FATIGUE_DEFENSE_MULT = 0.7

/** 每回合燃料基线消耗（非机动单位也消耗一点维持） */
export const FUEL_BASELINE_PER_TURN = 2

/** 每回合弹药基线消耗（前沿单位维持警戒） */
export const AMMO_BASELINE_PER_TURN = 2

/** 机动行动每格额外燃料消耗基数（乘 movementCost） */
export const FUEL_PER_CELL_MOVED = 3

/** 交战行动额外弹药消耗 */
export const AMMO_PER_ENGAGEMENT = 8

/** resupply 行动每回合恢复量（油/弹） */
export const RESUPPLY_AMOUNT = 25

/** 低补给阈值（status 加 low_supply 标记） */
export const LOW_SUPPLY_THRESHOLD = 20

/**
 * 补给被切断时的基线消耗倍率（第 4 批）。
 *
 * 连通=1.0，切断=SEVERED_SUPPLY_MULTIPLIER（=2.0，可被 rules.supply.severedMultiplier 覆写）。
 * 见 computeBaselineConsumption 的 supplyMultiplier 参数。
 * 与 src/layers/domain/supply.ts 中 SEVERED_SUPPLY_MULTIPLIER 保持同步（同名同值）。
 */
export const SEVERED_SUPPLY_MULTIPLIER = 2.0

/** 每回合疲劳自然恢复（未行动单位） */
export const FATIGUE_RECOVERY_PER_TURN = 5

/** 交战后疲劳增加 */
export const FATIGUE_GAIN_PER_ENGAGEMENT = 10

/** 机动行动疲劳增加（按距离） */
export const FATIGUE_GAIN_PER_CELL_MOVED = 2

/** 战败（受损）士气下降比例（每损失 1% strength 降 0.5 morale） */
export const MORALE_LOSS_PER_STRENGTH_PCT = 0.5

/** 歼灭阈值：strength <= 此值视为被歼灭（移出沙盘） */
export const ANNIHILATION_THRESHOLD = 0

/** 单次交战 strength 损失上限（避免一回合清场，保留消耗战节奏） */
export const MAX_STRENGTH_LOSS_PER_ENGAGEMENT = 50

// ============================================================================
// 纯函数：地形/类型查询
// ============================================================================

/**
 * 按坐标取地图单元（线性 cells 行优先）。
 *
 * @returns 单元；越界返回 null
 */
export function getCellAt(
  map: { cols: number; cells: MapCell[] },
  col: number,
  row: number,
): MapCell | null {
  if (map.cols <= 0) return null
  if (col < 0 || row < 0) return null
  const index = row * map.cols + col
  return map.cells[index] ?? null
}

// ============================================================================
// 纯函数：机动结算
// ============================================================================

/**
 * 机动结算输入。
 */
export interface MovementInput {
  /** 机动单位 */
  unit: Unit
  /** 目标单元（含 movementCost） */
  targetCell: MapCell
  /** 沿途经过的格数（路径长度，至少 1） */
  cellsToTraverse: number
  /** 注入的确定性随机（决定机动是否受阻等扰动） */
  rng: DeterministicRandom
}

/**
 * 机动结算输出。
 */
export interface MovementResult {
  /** 是否成功抵达（false=燃料不足/地形受阻） */
  success: boolean
  /** 实际消耗燃料 */
  fuelCost: number
  /** 增加疲劳 */
  fatigueGain: number
  /** 失败原因（success=true 时为 null） */
  reason: string | null
}

/**
 * 机动结算。
 *
 * 数值假设（见文件头）：
 * - 总燃料消耗 = FUEL_PER_CELL_MOVED * sum(movementCost along path)
 *   此处简化为按 cellsToTraverse * 目标格 movementCost 估算（路径解算在 M2 简化）。
 * - 地形阻力（movementCost 高）有概率导致机动受阻（高 movementCost → 低成功率）。
 *
 * @param input 见 MovementInput
 */
export function resolveMovement(input: MovementInput): MovementResult {
  const { unit, targetCell, cellsToTraverse, rng } = input
  const distance = Math.max(1, cellsToTraverse)

  // 燃料消耗：基数 * 距离 * 目标格地形阻力
  const fuelCost = FUEL_PER_CELL_MOVED * distance * Math.max(1, targetCell.movementCost)

  // 燃料不足则无法完成机动
  if (unit.fuel < fuelCost) {
    return {
      success: false,
      fuelCost: unit.fuel, // 耗尽剩余
      fatigueGain: 0,
      reason: '燃料不足，机动失败',
    }
  }

  // 地形受阻概率：movementCost 越高越易受阻（6 → ~50% 受阻）
  // 受阻概率 = min(0.5, (movementCost - 1) * 0.1)
  const blockChance = Math.min(0.5, Math.max(0, (targetCell.movementCost - 1) * 0.1))
  if (blockChance > 0 && rng.chance(blockChance)) {
    // 受阻：仍消耗部分燃料与疲劳，但未抵达
    return {
      success: false,
      fuelCost: Math.round(fuelCost * 0.5),
      fatigueGain: Math.round(FATIGUE_GAIN_PER_CELL_MOVED * distance * 0.5),
      reason: `地形阻力（${targetCell.movementCost}）导致机动受阻`,
    }
  }

  return {
    success: true,
    fuelCost,
    fatigueGain: FATIGUE_GAIN_PER_CELL_MOVED * distance,
    reason: null,
  }
}

// ============================================================================
// 纯函数：补给/消耗结算
// ============================================================================

/**
 * 回合基线消耗：每单位每回合扣基线 fuel/ammo。
 *
 * 纯函数返回消耗量，实际扣减由调用方应用到新状态（不可变产出）。
 *
 * @param unit 单位
 * @param supplyMultiplier 补给倍率（第 4 批，默认 1.0）：
 *   - 1.0（连通）：基线消耗不变。
 *   - >1.0（切断）：基线消耗按倍率放大（如 SEVERED_SUPPLY_MULTIPLIER=2.0 →
 *     fuel/ammo 基线消耗 ×2，体现补给被切断时物资加速耗尽）。
 *   由 worker applyBaselineToAll 据 computeSupplyConnectivity 结果注入。
 */
export function computeBaselineConsumption(
  unit: Unit,
  supplyMultiplier: number = 1.0,
): {
  fuelCost: number
  ammoCost: number
  fatigueDelta: number
} {
  // 未行动单位疲劳自然恢复（负 delta）
  const hasOrder = unit.orders.length > 0
  const mult = Math.max(0, supplyMultiplier)
  return {
    // 基线消耗按倍率放大（向上取整，避免 1.0→整数无损；2.0→×2）
    fuelCost: Math.ceil(FUEL_BASELINE_PER_TURN * mult),
    ammoCost: Math.ceil(AMMO_BASELINE_PER_TURN * mult),
    fatigueDelta: hasOrder ? 0 : -FATIGUE_RECOVERY_PER_TURN,
  }
}

/**
 * resupply 行动结算：恢复 fuel/ammo（不超过 100）。
 *
 * @returns 恢复后的新 fuel/ammo 数值（不修改原 unit）
 */
export function applyResupply(unit: Unit): { fuel: number; ammo: number } {
  return {
    fuel: Math.min(100, unit.fuel + RESUPPLY_AMOUNT),
    ammo: Math.min(100, unit.ammo + RESUPPLY_AMOUNT),
  }
}

// ============================================================================
// 纯函数：战损结算（核心公式）
// ============================================================================

/**
 * 战损结算输入。
 */
export interface DamageInput {
  /** 攻方单位 */
  attacker: Unit
  /** 守方单位 */
  defender: Unit
  /** 守方所在单元（含 defenseBonus） */
  defenderCell: MapCell
  /** 注入的确定性随机（命中扰动） */
  rng: DeterministicRandom
}

/**
 * 战损结算输出。
 */
export interface DamageResult {
  /** 攻方造成的 strength 损失（守方承受） */
  attackerDealt: number
  /** 守方反击造成的 strength 损失（攻方承受） */
  defenderDealt: number
  /** 攻方弹药消耗 */
  attackerAmmoCost: number
  /** 守方弹药消耗 */
  defenderAmmoCost: number
  /** 攻方疲劳增加 */
  attackerFatigueGain: number
  /** 守方疲劳增加 */
  defenderFatigueGain: number
}

/**
 * 装备折算火力加成倍率（第 5 批）。
 *
 * 无装备返回 1（保持旧存档兼容）。有装备时按 Σ(count * quality) 累积，
 * 受 EQUIPMENT_FIREPOWER_DIVISOR 抑制 + EQUIPMENT_FIREPOWER_GAIN 增益。
 *
 * @param equipment 装备槽列表（缺省/null 视为无装备）
 * @returns 火力倍率（>=1）
 */
export function computeEquipmentFirepowerBonus(
  equipment?: ReadonlyArray<EquipmentSlot> | null,
): number {
  if (!equipment || equipment.length === 0) return 1
  let weighted = 0
  for (const slot of equipment) {
    const count = Math.max(0, slot.count)
    const quality = Math.min(1, Math.max(0, slot.quality))
    weighted += count * quality
  }
  const bonus = 1 + (weighted / EQUIPMENT_FIREPOWER_DIVISOR) * EQUIPMENT_FIREPOWER_GAIN
  return bonus
}

/**
 * 计算单个单位的「有效火力」。
 *
 * = strength * (ammo/100) * 类型乘数 * 装备加成 * 火力系数 * 士气调制
 *
 * 第 5 批：装备槽（unit.equipment）通过 computeEquipmentFirepowerBonus 叠加加成。
 *
 * @param unit 单位
 */
export function computeEffectiveFirepower(unit: Unit): number {
  let fp = unit.strength
  fp *= unit.ammo / 100 // 弹药不足削弱火力
  fp *= FIREPOWER_MULT_BY_TYPE[unit.type] ?? 1
  // 第 5 批：装备加成（无装备为 1，不影响旧存档）
  fp *= computeEquipmentFirepowerBonus(unit.equipment)
  fp *= FIREPOWER_RATIO
  // 士气低落削弱
  if (unit.morale < LOW_MORALE_THRESHOLD) {
    fp *= LOW_MORALE_FIREPOWER_MULT
  }
  return fp
}

/**
 * 计算单个单位的「有效防御」。
 *
 * = strength * 类型乘数 * (1 + cell.defenseBonus) * (1 + 要塞单位加成) * 疲劳调制
 *
 * 第 5 批：attackerType 参数——当攻方为 air（空军跨格打击）时，
 * 守方地形防御加成（cell.defenseBonus）被忽略（野战工事挡不住空袭）。
 *
 * T1-A：单位 entrenchment（战壕）每级 +0.15 独立乘法因子；cell.fortificationLevel
 * （野战工事）每级 +0.1 独立乘法因子。两者叠加（既挖战壕又驻守旧工事时双重加成）。
 * 缺省（undefined）视为 0（兼容旧存档）。
 *
 * @param unit 守方单位
 * @param cell 守方所在单元
 * @param attackerType 攻方单位类型（可选；air 时忽略地形防御）
 */
export function computeEffectiveDefense(
  unit: Unit,
  cell: MapCell,
  attackerType?: UnitType,
): number {
  let def = unit.strength
  def *= DEFENSE_MULT_BY_TYPE[unit.type] ?? 1
  // 第 5 批：空军跨格打击忽略守方地形防御加成
  const ignoreTerrain =
    AIR_IGNORES_TERRAIN_DEFENSE && attackerType === 'air'
  def *= 1 + (ignoreTerrain ? 0 : (cell.defenseBonus ?? 0))
  // 要塞类型单位额外加成
  if (unit.type === 'fortress') {
    def *= 1 + FORTRESS_UNIT_DEFENSE_BONUS
  }
  // T1-A：单位自身战壕等级（entrenchment）防御加成
  const entrenchLevel = Math.max(0, unit.entrenchment ?? 0)
  if (entrenchLevel > 0) {
    def *= 1 + entrenchLevel * ENTRENCHMENT_DEFENSE_PER_LEVEL
  }
  // T1-A：单元格野战工事等级（fortificationLevel）防御加成（任何单位进入此格都吃到）
  const fortLevel = Math.max(0, cell.fortificationLevel ?? 0)
  if (fortLevel > 0) {
    def *= 1 + fortLevel * FORTIFICATION_CELL_DEFENSE_PER_LEVEL
  }
  // 高疲劳削弱防御
  if (unit.fatigue > HIGH_FATIGUE_THRESHOLD) {
    def *= HIGH_FATIGUE_DEFENSE_MULT
  }
  return def
}

/**
 * 战损结算（Lanchester 线性律简化版）。
 *
 * 数值假设（见文件头）：
 * - 攻方火力 vs 守方防御，净伤害 = max(0, 火力-防御) * 扰动 * 折算
 * - 守方有反击（按自身火力，但削弱——防御方反击系数 0.5）
 * - 单次交战 strength 损失上限 MAX_STRENGTH_LOSS_PER_ENGAGEMENT
 *
 * @param input 见 DamageInput
 */
export function resolveDamage(input: DamageInput): DamageResult {
  const { attacker, defender, defenderCell, rng } = input

  const attackerFp = computeEffectiveFirepower(attacker)
  // 第 5 批：空军跨格打击忽略守方地形防御（attacker.type 传入）
  const defenderDef = computeEffectiveDefense(defender, defenderCell, attacker.type)

  // 攻方净伤害（火力 - 防御，负则 0）
  const attackerNet = Math.max(0, attackerFp - defenderDef)
  // 命中随机扰动 ±15%
  const attackerJitter = 1 + (rng.nextFloat() * 2 - 1) * DAMAGE_JITTER
  // 折算：净伤害 * 扰动 * 0.1（强度到损失点数折算，控制单回合损失节奏）
  let attackerDealt = Math.min(
    MAX_STRENGTH_LOSS_PER_ENGAGEMENT,
    Math.max(0, attackerNet * attackerJitter * 0.1),
  )
  attackerDealt = Math.round(attackerDealt)

  // 守方反击（按自身火力，防御方反击削弱）
  const defenderFp = computeEffectiveFirepower(defender)
  // 反击需守方还有弹药且未被压制
  const defenderSuppressed = defender.status.includes('suppressed')
  const counterFactor = defenderSuppressed ? 0.1 : 0.5
  const defenderNet = Math.max(0, defenderFp * counterFactor - computeEffectiveFirepower(attacker) * 0.3)
  const defenderJitter = 1 + (rng.nextFloat() * 2 - 1) * DAMAGE_JITTER
  let defenderDealt = Math.min(
    MAX_STRENGTH_LOSS_PER_ENGAGEMENT,
    Math.max(0, defenderNet * defenderJitter * 0.1),
  )
  defenderDealt = Math.round(defenderDealt)

  return {
    attackerDealt,
    defenderDealt,
    attackerAmmoCost: AMMO_PER_ENGAGEMENT,
    defenderAmmoCost: AMMO_PER_ENGAGEMENT,
    attackerFatigueGain: FATIGUE_GAIN_PER_ENGAGEMENT,
    defenderFatigueGain: FATIGUE_GAIN_PER_ENGAGEMENT,
  }
}

// ============================================================================
// 纯函数：士气/状态衍生
// ============================================================================

/**
 * 根据本回合 strength 损失计算士气变动。
 *
 * 每损失 1 点 strength → 降 MORALE_LOSS_PER_STRENGTH_PCT 士气。
 *
 * @param strengthLost 本回合损失 strength
 */
export function computeMoraleLoss(strengthLost: number): number {
  return Math.round(strengthLost * MORALE_LOSS_PER_STRENGTH_PCT)
}

/**
 * 判断单位是否被歼灭（strength 归零）。
 */
export function isAnnihilated(unit: Unit): boolean {
  return unit.strength <= ANNIHILATION_THRESHOLD
}

/**
 * 判断单位是否进入低补给状态。
 */
export function isLowSupply(unit: Unit): boolean {
  return unit.fuel <= LOW_SUPPLY_THRESHOLD || unit.ammo <= LOW_SUPPLY_THRESHOLD
}

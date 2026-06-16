/**
 * 战斗结算（combat.ts）— 基于 physics-rules 的纯函数战斗解析。
 *
 * 处理 attack / capture_node 等 intent，基于 physics-rules 的火力-防御公式
 * 结算 strength/personnel 损失、士气/疲劳影响，产出战损事件（source:'physics'）。
 *
 * 全纯函数，随机数由调用方注入 DeterministicRandom。相同输入 → 相同输出。
 *
 * === ResolutionResult / ResolutionEvent 设计 ===
 *
 * `ResolutionEvent` 是物理层结算的最细粒度产物，每条标 source:'physics'。
 * 回放时（验收#7）physics 类事件可重算校验；M3 导演部可覆写但留痕。
 *
 * @module layers/domain/combat
 */

import type {
  WorldState,
  Unit,
  ActionEnvelope,
  GridCoord,
  MapCell,
  IntelObservation,
} from '@/types'
import type { DeterministicRandom } from './deterministic-random'
import {
  resolveDamage,
  getCellAt,
  computeMoraleLoss,
} from './physics-rules'

// ============================================================================
// 结算产物类型（ResolutionEvent / ResolutionResult）
// ============================================================================

/**
 * 物理层结算事件类型。
 */
export type ResolutionEventKind =
  | 'movement' // 机动
  | 'engagement' // 交火
  | 'capture' // 占领节点
  | 'resupply' // 补给
  | 'casualty' // 歼灭
  | 'blockade' // 受阻/失败
  | 'recon' // 主动侦察命中（升级目标单位对该方的情报等级）
  | 'hold' // Bug2：就地固守设防（不移动；士气+恢复、疲劳-恢复，地形防御×1.5 留痕）
  | 'random_event' // 战役随机事件（暴雨/毒气/援军/兵变/炮击，source:'director' 采信 log）
  | 'supply_cut' // 第 4 批：单位补给本回合被切断（上回合连通→本回合切断）
  | 'supply_restored' // 第 4 批：单位补给本回合恢复（上回合切断→本回合连通）
  | 'supply_blocked' // 第 4 批：resupply 命令因不连通被拒绝（不 +25）

/**
 * 物理层结算事件（event-log 一条目级产物）。
 *
 * 每条标 source:'physics'，回放可重算校验（确定性两层）。
 */
export interface ResolutionEvent {
  /** 事件唯一 id（确定性派生：seed:sequence:kind:index） */
  id: string
  /** 来源标记（物理层恒为 'physics'；director/rule-engine 在别处） */
  source: 'physics'
  /** 所属回合 */
  turn: number
  /** 关联的 ActionEnvelope.sequence（回放对齐用） */
  sequence: number
  /** 关联 Agent id（可选，便于 UI 联动） */
  agentId?: string
  /** 事件类别 */
  kind: ResolutionEventKind
  /** 人类可读描述（数值摘要，非叙事——叙事由 director 润色） */
  description: string
  /** 结构化数值载荷（人员/strength/燃料/弹药变动等） */
  data: Record<string, unknown>
}

/**
 * 物理层回合结算结果（Worker 产出，可被 M3 导演部覆写）。
 */
export interface ResolutionResult {
  /** 结算回合 */
  turn: number
  /** 本回合物理结算事件序列（按 sequence 升序） */
  events: ResolutionEvent[]
  /** 状态变更：单位级增量更新（apply 到 worldState 产出新状态） */
  stateChanges: CombatStateChanges
  /** 是否结算成功（false=异常但已尽力产出空结果） */
  success: boolean
  /** 错误信息（success=false 时） */
  error?: string
}

/**
 * 单位级状态变更（不可变产出，由 Worker 汇总、主线程应用）。
 */
export interface CombatStateChanges {
  /** 单位更新：unitId → 变更字段部分（detection 仅 recon 命中时写入局部观测记录） */
  unitUpdates: Record<
    string,
    Partial<
      Pick<
        Unit,
        'strength' | 'personnel' | 'fuel' | 'ammo' | 'morale' | 'fatigue' | 'coord' | 'status'
      > & {
        /**
         * recon 命中产出的情报观测增量：key=observerFactionId（侦察执行方），
         * value=刷新后的 IntelObservation（已调 refreshOnRecon）。
         * 仅含本回合被侦察刷新的（observerFactionId, unitId）组合，
         * 应用时合并到 world.units[unitId].detection[observerFactionId]。
         */
        detection?: Record<string, IntelObservation>
      }
    >
  >
  /** 本回合被歼灭的 unitId 列表 */
  annihilated: string[]
  /** 高价值节点控制变更 */
  objectiveChanges: Array<{ nodeId: string; toFactionId: string }>
  /**
   * 本回合 recon 命中记录（追加到 world.intel.reconHits 流）。
   * 每条 = 一次（observerFactionId, unitId）侦察刷新，turn 由结算回合填充。
   */
  intelReconHits?: Array<{ observerFactionId: string; unitId: string }>
}

// ============================================================================
// 纯函数：交战结算
// ============================================================================

/**
 * 单次交战结算（attack / capture_node 共用）。
 *
 * 数值假设（见 physics-rules）：攻方火力 vs 守方防御，含地形/要塞/士气/疲劳调制。
 *
 * @param params 见 ResolveEngagementParams
 */
export interface ResolveEngagementParams {
  /** 当前世界状态（只读，用于查询单位/单元） */
  world: WorldState
  /** 攻方单位 */
  attacker: Unit
  /** 守方单位 id（找不到则视为空目标，结算失败事件） */
  defenderId: string
  /** 守方所在单元（若与 defender.coord 不一致由调用方传入） */
  defenderCell?: MapCell
  /** 注入的确定性随机 */
  rng: DeterministicRandom
  /** 所属 ActionEnvelope.sequence（事件留痕） */
  sequence: number
  /** 所属回合 */
  turn: number
  /** 关联 Agent id */
  agentId?: string
}

/**
 * 单次交战结算结果。
 */
export interface EngagementOutcome {
  /** 产出的事件（engagement，可能含 casualty） */
  events: ResolutionEvent[]
  /** 单位状态变更增量 */
  attackerChange: Partial<Unit>
  defenderChange: Partial<Unit>
  /** 守方是否被歼灭 */
  defenderAnnihilated: boolean
}

/**
 * 结算一次交战。
 */
export function resolveEngagement(params: ResolveEngagementParams): EngagementOutcome {
  const { world, attacker, defenderId, rng, sequence, turn, agentId } = params

  const defender = world.units.find((u) => u.id === defenderId)
  if (!defender) {
    return {
      events: [
        {
          id: makeEventId(rng, sequence, 'engagement', 0),
          source: 'physics',
          turn,
          sequence,
          agentId,
          kind: 'engagement',
          description: `目标 ${defenderId} 不存在，交战未发生`,
          data: { attackerId: attacker.id, defenderId, outcome: 'no_target' },
        },
      ],
      attackerChange: {},
      defenderChange: {},
      defenderAnnihilated: false,
    }
  }

  const defenderCell =
    params.defenderCell ?? getCellAt(world.map, defender.coord.col, defender.coord.row)
  // 找不到守方单元：用零防御加成兜底（不应发生，保证结算不抛错）
  const effectiveCell: MapCell =
    defenderCell ?? {
      id: `${defender.coord.col}:${defender.coord.row}`,
      col: defender.coord.col,
      row: defender.coord.row,
      terrain: 'plain',
      movementCost: 1,
      defenseBonus: 0,
      isObjective: false,
    }

  const damage = resolveDamage({ attacker, defender, defenderCell: effectiveCell, rng })

  // 应用战损（不可变，产出变更增量）
  const newDefenderStrength = Math.max(0, defender.strength - damage.attackerDealt)
  const newAttackerStrength = Math.max(0, attacker.strength - damage.defenderDealt)
  const defenderAnnihilated = newDefenderStrength <= 0

  // 人员损失按 strength 比例折算（strength 是 0..100 归一化，personnel 是绝对数）
  const defenderPersonnelLoss = Math.round(
    defender.personnel * (damage.attackerDealt / Math.max(1, defender.strength)),
  )
  const attackerPersonnelLoss = Math.round(
    attacker.personnel * (damage.defenderDealt / Math.max(1, attacker.strength)),
  )

  // 士气/疲劳
  const defenderMoraleLoss = computeMoraleLoss(damage.attackerDealt)
  const attackerMoraleLoss = computeMoraleLoss(damage.defenderDealt)

  const attackerChange: Partial<Unit> = {
    strength: newAttackerStrength,
    personnel: Math.max(0, attacker.personnel - attackerPersonnelLoss),
    ammo: Math.max(0, attacker.ammo - damage.attackerAmmoCost),
    fatigue: Math.min(100, attacker.fatigue + damage.attackerFatigueGain),
    morale: Math.max(0, attacker.morale - attackerMoraleLoss),
  }
  const defenderChange: Partial<Unit> = {
    strength: newDefenderStrength,
    personnel: Math.max(0, defender.personnel - defenderPersonnelLoss),
    ammo: Math.max(0, defender.ammo - damage.defenderAmmoCost),
    fatigue: Math.min(100, defender.fatigue + damage.defenderFatigueGain),
    morale: Math.max(0, defender.morale - defenderMoraleLoss),
  }

  const events: ResolutionEvent[] = [
    {
      id: makeEventId(rng, sequence, 'engagement', 0),
      source: 'physics',
      turn,
      sequence,
      agentId,
      kind: 'engagement',
      description: `${attacker.id} 交火 ${defender.id}：守方 -${damage.attackerDealt}str，攻方 -${damage.defenderDealt}str`,
      data: {
        attackerId: attacker.id,
        defenderId: defender.id,
        attackerLoss: damage.defenderDealt,
        defenderLoss: damage.attackerDealt,
        attackerPersonnelLoss,
        defenderPersonnelLoss,
        defenderAnnihilated,
        terrain: effectiveCell.terrain,
        defenseBonus: effectiveCell.defenseBonus,
      },
    },
  ]

  if (defenderAnnihilated) {
    events.push({
      id: makeEventId(rng, sequence, 'casualty', 1),
      source: 'physics',
      turn,
      sequence,
      agentId,
      kind: 'casualty',
      description: `${defender.id} 被歼灭`,
      data: { unitId: defender.id, factionId: defender.factionId },
    })
  }

  return { events, attackerChange, defenderChange, defenderAnnihilated }
}

// ============================================================================
// 纯函数：占领导出
// ============================================================================

/**
 * 占领节点结算：capture_node intent。
 *
 * 数值假设：
 * - 攻方需先击败/驱逐守方（若该格有敌方单位 → 触发交战）。
 * - 守方清场后，攻方占据高价值节点（controlThreshold 累计驻守回合，domain 简化为本回合即占）。
 *
 * @param params 同 resolveEngagement + 节点 id
 */
export interface CaptureOutcome {
  events: ResolutionEvent[]
  attackerChange: Partial<Unit>
  defenderChange: Partial<Unit>
  captured: boolean
}

/**
 * 结算占领节点。
 */
export function resolveCapture(
  params: ResolveEngagementParams & { nodeId: string },
): CaptureOutcome {
  const { nodeId } = params
  const engagement = resolveEngagement(params)

  // 仅当守方被歼灭或本就无守方时算占领成功
  const captured = engagement.defenderAnnihilated || engagement.events[0]?.data.outcome === 'no_target'

  const captureEvents: ResolutionEvent[] = captured
    ? [
        {
          id: makeEventId(params.rng, params.sequence, 'capture', 2),
          source: 'physics',
          turn: params.turn,
          sequence: params.sequence,
          agentId: params.agentId,
          kind: 'capture',
          description: `${nodeId} 被 ${params.attacker.factionId} 占领`,
          data: {
            nodeId,
            attackerId: params.attacker.id,
            factionId: params.attacker.factionId,
          },
        },
      ]
    : [
        {
          id: makeEventId(params.rng, params.sequence, 'blockade', 2),
          source: 'physics',
          turn: params.turn,
          sequence: params.sequence,
          agentId: params.agentId,
          kind: 'blockade',
          description: `${nodeId} 占领失败：守方未清除`,
          data: { nodeId, reason: 'defender_standing' },
        },
      ]

  return {
    events: [...engagement.events, ...captureEvents],
    attackerChange: engagement.attackerChange,
    defenderChange: engagement.defenderChange,
    captured,
  }
}

// ============================================================================
// 纯函数：辅助
// ============================================================================

/**
 * 由确定性种子派生事件 id（保证回放一致）。
 *
 * 格式：`evt:<sequence>:<kind>:<index>`。不引入额外随机，保证幂等。
 */
export function makeEventId(
  _rng: DeterministicRandom,
  sequence: number,
  kind: ResolutionEventKind,
  index: number,
): string {
  return `evt:${sequence}:${kind}:${index}`
}

/**
 * 从 ActionEnvelope.payload 安全提取字段（解析可能不完整）。
 */
export function extractPayloadField<T = unknown>(
  envelope: ActionEnvelope,
  key: string,
): T | undefined {
  return envelope.payload[key] as T | undefined
}

/**
 * 从 payload 提取坐标（支持 {col,row} 或字符串 "col,row"）。
 */
export function extractCoord(envelope: ActionEnvelope, key = 'target'): GridCoord | undefined {
  const raw = envelope.payload[key]
  if (!raw) return undefined
  if (typeof raw === 'object' && raw !== null && 'col' in raw && 'row' in raw) {
    const c = raw as { col: unknown; row: unknown }
    if (typeof c.col === 'number' && typeof c.row === 'number') {
      return { col: c.col, row: c.row }
    }
  }
  if (typeof raw === 'string') {
    const [c, r] = raw.split(/[,\s]+/).map((n) => Number.parseInt(n, 10))
    if (!Number.isNaN(c) && !Number.isNaN(r)) return { col: c, row: r }
  }
  return undefined
}

// 重新导出 physics-rules 判定函数供 worker/测试便捷引用
export { isAnnihilated as combatIsAnnihilated, isLowSupply as combatIsLowSupply } from './physics-rules'

// ============================================================================
// 纯函数：把 recon 命中的情报增量应用到 world（内存实时应用 + 回放重建共用）
// ============================================================================

/**
 * 把结算结果中的情报增量（detection 局部观测 + reconHits 流）应用到 world。
 *
 * 用途（两处共用同一逻辑，保证内存实时态与回放重建态一致）：
 * - **内存实时应用**：resolver 结算后调用，让 UI 在 briefing 阶段立即看到
 *   被侦察区域的敌方 level 提升（无需 reload）。
 * - **回放重建**：replay.restoreFromEventLog 在 commit 阶段同样应用
 *   （回放从 event-log 重算 detection，保证二次回放一致）。
 *
 * 处理：
 * - stateChanges.unitUpdates[unitId].detection[observerFactionId] 合并到
 *   world.units[unitId].detection[observerFactionId]（覆盖该观测记录，level 不降）。
 * - stateChanges.intelReconHits 追加到 world.intel.reconHits（turn 填结算回合）。
 *
 * 不可变产出：返回新 world（深拷贝 units/intel），不修改输入。
 * 仅当 stateChanges 含 detection 增量或 intelReconHits 时才拷贝（无变更直接返回原 world）。
 *
 * @param world 当前世界状态（只读）
 * @param stateChanges 物理结算的增量（含 detection/intelReconHits）
 * @param turn 结算回合（reconHits 流的 turn 字段）
 * @returns 应用情报增量后的新 world（无变更时返回原 world）
 */
export function applyResolutionToIntel(
  world: WorldState,
  stateChanges: CombatStateChanges,
  turn: number,
): WorldState {
  // 收集有 detection 增量的 unitId
  const detectionUnitIds = Object.entries(stateChanges.unitUpdates)
    .filter(([, upd]) => upd && typeof upd === 'object' && 'detection' in upd && upd.detection)
    .map(([id]) => id)
  const reconHits = stateChanges.intelReconHits ?? []

  // 无情报变更：直接返回原 world（避免无谓深拷贝）
  if (detectionUnitIds.length === 0 && reconHits.length === 0) {
    return world
  }

  // 应用 detection 增量（不可变：仅替换被刷新单位的 detection）
  const detectionSet = new Set(detectionUnitIds)
  const newUnits = world.units.map((unit) => {
    if (!detectionSet.has(unit.id)) return unit
    const upd = stateChanges.unitUpdates[unit.id]
    const detDelta = upd?.detection
    if (!detDelta) return unit
    // 合并：observerFactionId → 刷新后的 IntelObservation（覆盖该观测）
    const mergedDetection: Record<string, IntelObservation> = { ...unit.detection }
    for (const [observerFactionId, observation] of Object.entries(detDelta)) {
      mergedDetection[observerFactionId] = observation
    }
    return { ...unit, detection: mergedDetection }
  })

  // 追加 reconHits（turn 填结算回合）
  const newReconHits = reconHits.map((h) => ({
    turn,
    observerFactionId: h.observerFactionId,
    unitId: h.unitId,
  }))

  return {
    ...world,
    units: newUnits,
    intel: {
      ...world.intel,
      reconHits: [...world.intel.reconHits, ...newReconHits],
    },
  }
}

// ============================================================================
// 纯函数：把完整结算增量（数值 + 情报 + 歼灭 + 目标）应用到 world（内存实时态）
// ============================================================================

/**
 * Bug1/Bug2/Bug4 核心根因修复：把物理结算的**完整** stateChanges 应用到内存 world。
 *
 * 历史问题：内存实时路径（turn-orchestrator 调用）只 `applyResolutionToIntel`，
 * **仅**应用 detection/reconHits 增量，数值字段（coord/strength/fuel/ammo/morale/
 * fatigue/status）从不落地 → 单位坐标永远不变（Bug1）、hold 数值不生效（Bug2）、
 * 侦查后敌方 level 升了但其他数值看不到（Bug4 部分）。回放路径（replay.commitStateChanges）
 * 反而是完整的，导致"回放与实时态不一致"。
 *
 * 本函数补齐内存实时路径：完整 apply 所有字段，与 replay.commitStateChanges 语义对齐
 * （但不可变产出，不改入参；replay 为性能在回放热路径用 mutable，内存路径用不可变更安全）。
 *
 * 处理：
 * 1. 单位数值变更（coord/strength/personnel/fuel/ammo/morale/fatigue/status）落到对应单位。
 * 2. detection 增量（recon 命中）：合并 observer → IntelObservation（覆盖该观测，level 不降）。
 * 3. 歼灭单位从 world.units 移除。
 * 4. reconHits 追加到 world.intel.reconHits（turn 填结算回合）。
 * 5. objectiveChanges 暂存到返回值的 pendingObjectiveChanges（M4 节点控制权落地扩展点）。
 *
 * 不可变产出：返回新 world（深拷贝 units/intel），不修改输入。无任何变更时返回原 world。
 *
 * @param world 当前世界状态（只读）
 * @param stateChanges 物理结算的完整增量
 * @param turn 结算回合（reconHits 流的 turn 字段）
 * @returns 应用完整增量后的新 world（无变更时返回原 world）
 */
export function applyResolutionStateChanges(
  world: WorldState,
  stateChanges: CombatStateChanges,
  turn: number,
): WorldState {
  const unitIds = Object.keys(stateChanges.unitUpdates)
  const hasNumericChanges = unitIds.length > 0
  const hasAnnihilated = stateChanges.annihilated.length > 0
  const reconHits = stateChanges.intelReconHits ?? []
  const hasReconHits = reconHits.length > 0

  // 无任何变更：直接返回原 world（避免无谓深拷贝）
  if (!hasNumericChanges && !hasAnnihilated && !hasReconHits) {
    return world
  }

  // 1+2. 应用单位数值变更 + detection 增量（一次遍历同时处理两类）
  const updateSet = new Set(unitIds)
  let unitsChanged = false
  const newUnits = world.units.map((unit) => {
    if (!updateSet.has(unit.id)) return unit
    const upd = stateChanges.unitUpdates[unit.id]
    if (!upd) return unit
    const next: Unit = { ...unit }
    let changed = false
    if (upd.coord !== undefined) {
      next.coord = upd.coord
      changed = true
    }
    if (upd.strength !== undefined) {
      next.strength = upd.strength
      changed = true
    }
    if (upd.personnel !== undefined) {
      next.personnel = upd.personnel
      changed = true
    }
    if (upd.fuel !== undefined) {
      next.fuel = upd.fuel
      changed = true
    }
    if (upd.ammo !== undefined) {
      next.ammo = upd.ammo
      changed = true
    }
    if (upd.morale !== undefined) {
      next.morale = upd.morale
      changed = true
    }
    if (upd.fatigue !== undefined) {
      next.fatigue = upd.fatigue
      changed = true
    }
    if (upd.status !== undefined) {
      next.status = upd.status
      changed = true
    }
    // detection 增量（recon 命中）：合并 observer → IntelObservation（覆盖该观测记录）
    if (upd.detection) {
      const detDelta = upd.detection as Record<string, IntelObservation>
      next.detection = { ...unit.detection }
      for (const [observerFactionId, observation] of Object.entries(detDelta)) {
        next.detection[observerFactionId] = observation
      }
      changed = true
    }
    if (changed) unitsChanged = true
    return next
  })

  // 3. 歼灭单位移除
  let finalUnits = newUnits
  if (hasAnnihilated) {
    const dead = new Set(stateChanges.annihilated)
    finalUnits = newUnits.filter((u) => !dead.has(u.id))
    unitsChanged = true
  }

  // 无实际单位变更且无 reconHits：返回原 world（数值/detection 增量可能为空对象）
  if (!unitsChanged && !hasReconHits) {
    return world
  }

  // 4. reconHits 追加到 world.intel.reconHits（turn 填结算回合）
  const newReconHits = reconHits.map((h) => ({
    turn,
    observerFactionId: h.observerFactionId,
    unitId: h.unitId,
  }))

  return {
    ...world,
    units: finalUnits,
    intel: {
      ...world.intel,
      reconHits: [...world.intel.reconHits, ...newReconHits],
    },
  }
}

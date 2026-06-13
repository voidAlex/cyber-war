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
  /** 单位更新：unitId → 变更字段部分 */
  unitUpdates: Record<
    string,
    Partial<Pick<Unit, 'strength' | 'personnel' | 'fuel' | 'ammo' | 'morale' | 'fatigue' | 'coord' | 'status'>>
  >
  /** 本回合被歼灭的 unitId 列表 */
  annihilated: string[]
  /** 高价值节点控制变更 */
  objectiveChanges: Array<{ nodeId: string; toFactionId: string }>
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

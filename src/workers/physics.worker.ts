/**
 * 物理引擎 Web Worker（physics.worker.ts）— 确定性、可回放的回合结算。
 *
 * TDD 决策#10：物理引擎跑在独立 Worker，隔离主线程不卡 UI。
 *
 * 确定性契约（重写计划「确定性两层」「防坑-确定性 sequence」）：
 * - Worker 接收 { worldState, lockedOrders, scenarioSeed, turn }。
 * - 对每个 lockedOrder（ActionEnvelope，含预分配 sequence），构造
 *   DeterministicRandom.fromSequence(scenarioSeed, turn, sequence)。
 *   即便多 Agent 真并行调度，每个 envelope 拿到的种子仍稳定 → 回放一致。
 * - 全部随机数来自注入的 DeterministicRandom，**禁止 Math.random/Date.now**。
 *
 * 产出 ResolutionResult{ turn, events[], stateChanges, success }：
 * - events 每条标 source:'physics'（确定性两层）。
 * - 结果可被 M3 导演部覆写（director 留痕）。
 *
 * 相同 (worldState, lockedOrders, scenarioSeed, turn) → 相同 ResolutionResult。
 *
 * @module workers/physics
 */

/// <reference lib="webworker" />

import type { WorldState, ActionEnvelope } from '@/types'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import {
  resolveEngagement,
  resolveCapture,
  extractPayloadField,
  extractCoord,
} from '@/layers/domain/combat'
import {
  applyResupply,
  computeBaselineConsumption,
  resolveMovement,
  getCellAt,
  isAnnihilated,
} from '@/layers/domain/physics-rules'
import type {
  ResolutionResult,
  ResolutionEvent,
  CombatStateChanges,
} from '@/layers/domain/combat'

// Worker 线程声明
declare const self: DedicatedWorkerGlobalScope

// ============================================================================
// Worker 消息协议
// ============================================================================

/**
 * Worker 接收的结算请求。
 */
export interface PhysicsWorkerRequest {
  /** 当前世界状态快照（只读） */
  worldState: WorldState
  /** 本回合锁定的命令（按 factionId 分组的 ActionEnvelope 扁平化为数组） */
  lockedOrders: ActionEnvelope[]
  /** 场景固定种子（确定性 base） */
  scenarioSeed: string
  /** 结算回合索引 */
  turn: number
}

/**
 * Worker 返回的结算结果包装。
 */
export type PhysicsWorkerResponse =
  | { type: 'RESOLVE_COMPLETE'; result: ResolutionResult }
  | { type: 'ERROR'; message: string }

// ============================================================================
// 主消息循环
// ============================================================================

/**
 * 安装 Worker 消息处理。
 *
 * 用运行时守卫包裹 self 赋值：在浏览器 Worker 内 self 存在则安装 onmessage；
 * 在 Node/vitest 测试环境直接 import 本模块时 self 未定义则跳过安装，
 * 使纯函数 simulateTurn 可在测试中直接调用（不拉起 Worker）。
 */
function installWorkerHandler(): void {
  // typeof self !== 'undefined' 在浏览器 Worker 内为真
  if (typeof self === 'undefined') return
  const workerSelf = self as DedicatedWorkerGlobalScope
  workerSelf.onmessage = (event: MessageEvent<PhysicsWorkerRequest>): void => {
    try {
      const { worldState, lockedOrders, scenarioSeed, turn } = event.data
      const result = simulateTurn(worldState, lockedOrders, scenarioSeed, turn)
      const response: PhysicsWorkerResponse = { type: 'RESOLVE_COMPLETE', result }
      workerSelf.postMessage(response)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown simulation error'
      const response: PhysicsWorkerResponse = { type: 'ERROR', message }
      workerSelf.postMessage(response)
    }
  }
}

installWorkerHandler()

// ============================================================================
// 回合结算核心（纯函数逻辑，可在 Worker 内直接执行）
// ============================================================================

/**
 * 模拟一个完整回合：对所有 lockedOrders 结算。
 *
 * 处理顺序：按 ActionEnvelope.sequence 升序（确定性，与调度完成顺序无关）。
 *
 * 支持的 intent（payload 字段约定）：
 * - 'move' / 'movement'：{ unitId, target: {col,row} | "col,row" }
 * - 'attack' / 'attack_node'：{ unitId, targetUnitId }
 * - 'capture_node'：{ unitId, targetUnitId, nodeId }
 * - 'resupply'：{ unitId }
 * - 其它 intent：记为 action_executed 占位事件（不结算）。
 *
 * @param worldState 只读世界状态
 * @param lockedOrders 锁定命令列表
 * @param scenarioSeed 场景种子
 * @param turn 回合索引
 */
export function simulateTurn(
  worldState: WorldState,
  lockedOrders: ActionEnvelope[],
  scenarioSeed: string,
  turn: number,
): ResolutionResult {
  // 按 sequence 升序排序（确定性）
  const ordered = [...lockedOrders].sort((a, b) => a.sequence - b.sequence)

  const events: ResolutionEvent[] = []
  const stateChanges: CombatStateChanges = {
    unitUpdates: {},
    annihilated: [],
    objectiveChanges: [],
  }

  // 第一遍：应用回合基线消耗（油/弹/疲劳恢复）到所有单位
  // 注意：基线消耗不带随机数，是确定性常量；此处先建立基线变更增量。
  const baselineUpdates = applyBaselineToAll(worldState, turn)

  // 第二遍：逐个命令结算
  for (const envelope of ordered) {
    // 每条命令一个独立的 DeterministicRandom（seed = scenarioSeed:turn:sequence）
    const rng = DeterministicRandom.fromSequence(scenarioSeed, turn, envelope.sequence)
    const intent = normalizeIntent(envelope.intent)

    switch (intent) {
      case 'move':
        resolveMoveOrder(worldState, envelope, rng, events, stateChanges, turn)
        break
      case 'attack':
        resolveAttackOrder(worldState, envelope, rng, events, stateChanges, turn)
        break
      case 'capture':
        resolveCaptureOrder(worldState, envelope, rng, events, stateChanges, turn)
        break
      case 'resupply':
        resolveResupplyOrder(worldState, envelope, rng, events, stateChanges, turn)
        break
      default:
        events.push({
          id: `evt:${envelope.sequence}:action_executed:0`,
          source: 'physics',
          turn,
          sequence: envelope.sequence,
          agentId: envelope.agentId,
          kind: 'blockade',
          description: `命令「${envelope.intent}」未实现物理结算，占位记录`,
          data: { intent: envelope.intent, agentId: envelope.agentId, outcome: 'unsupported' },
        })
    }
  }

  // 合并基线消耗到 stateChanges（不覆盖命令已产生的变更）
  for (const [unitId, baseline] of Object.entries(baselineUpdates)) {
    const existing = stateChanges.unitUpdates[unitId] ?? {}
    stateChanges.unitUpdates[unitId] = mergeBaseline(existing, baseline)
  }

  return {
    turn,
    events,
    stateChanges,
    success: true,
  }
}

// ============================================================================
// 各 intent 结算
// ============================================================================

/**
 * 归一化 intent 字符串到内部类别。
 */
function normalizeIntent(intent: string): 'move' | 'attack' | 'capture' | 'resupply' | 'other' {
  const lower = intent.toLowerCase().trim()
  if (lower === 'move' || lower === 'movement' || lower === 'march' || lower === 'advance') {
    return 'move'
  }
  if (lower === 'attack' || lower === 'attack_node' || lower === 'assault' || lower === 'engage') {
    return 'attack'
  }
  if (lower === 'capture_node' || lower === 'capture' || lower === 'occupy' || lower === 'seize') {
    return 'capture'
  }
  if (lower === 'resupply' || lower === 'refuel' || lower === 'rearm' || lower === 'logistics') {
    return 'resupply'
  }
  return 'other'
}

/**
 * 取单位（已应用 stateChanges 增量后的视图）。
 */
function getEffectiveUnit(
  worldState: WorldState,
  stateChanges: CombatStateChanges,
  unitId: string,
) {
  const base = worldState.units.find((u) => u.id === unitId)
  if (!base) return null
  const update = stateChanges.unitUpdates[unitId] ?? {}
  return { ...base, ...update }
}

/**
 * 结算机动命令。
 */
function resolveMoveOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
  rng: DeterministicRandom,
  events: ResolutionEvent[],
  stateChanges: CombatStateChanges,
  turn: number,
): void {
  const unitId = extractPayloadField<string>(envelope, 'unitId')
  const targetCoord = extractCoord(envelope, 'target') ?? extractCoord(envelope, 'destination')

  if (!unitId) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少 unitId', {}))
    return
  }
  const unit = getEffectiveUnit(worldState, stateChanges, unitId)
  if (!unit) {
    events.push(makeBlockadeEvent(envelope, turn, `单位 ${unitId} 不存在`, { unitId }))
    return
  }
  if (!targetCoord) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少目标坐标', { unitId }))
    return
  }
  const targetCell = getCellAt(worldState.map, targetCoord.col, targetCoord.row)
  if (!targetCell) {
    events.push(makeBlockadeEvent(envelope, turn, '目标坐标越界', { unitId, target: targetCoord }))
    return
  }

  // 距离估算（曼哈顿距离，M2 简化路径）
  const distance =
    Math.abs(unit.coord.col - targetCoord.col) + Math.abs(unit.coord.row - targetCoord.row)
  if (distance <= 0) {
    events.push(makeBlockadeEvent(envelope, turn, '已在目标格', { unitId }))
    return
  }

  const result = resolveMovement({
    unit,
    targetCell,
    cellsToTraverse: distance,
    rng,
  })

  // 合并变更增量
  const existing = stateChanges.unitUpdates[unitId] ?? {}
  if (result.success) {
    stateChanges.unitUpdates[unitId] = {
      ...existing,
      fuel: Math.max(0, unit.fuel - result.fuelCost),
      fatigue: Math.min(100, unit.fatigue + result.fatigueGain),
      coord: targetCoord,
    }
    events.push({
      id: `evt:${envelope.sequence}:movement:0`,
      source: 'physics',
      turn,
      sequence: envelope.sequence,
      agentId: envelope.agentId,
      kind: 'movement',
      description: `${unitId} 机动至 (${targetCoord.col},${targetCoord.row})`,
      data: {
        unitId,
        from: unit.coord,
        to: targetCoord,
        distance,
        fuelCost: result.fuelCost,
        fatigueGain: result.fatigueGain,
        terrain: targetCell.terrain,
      },
    })
  } else {
    // 受阻/燃料不足：仍扣部分燃料与疲劳
    stateChanges.unitUpdates[unitId] = {
      ...existing,
      fuel: Math.max(0, unit.fuel - result.fuelCost),
      fatigue: Math.min(100, unit.fatigue + result.fatigueGain),
    }
    events.push(makeBlockadeEvent(envelope, turn, result.reason ?? '机动失败', {
      unitId,
      target: targetCoord,
      fuelCost: result.fuelCost,
      fatigueGain: result.fatigueGain,
    }))
  }
}

/**
 * 结算攻击命令。
 */
function resolveAttackOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
  rng: DeterministicRandom,
  events: ResolutionEvent[],
  stateChanges: CombatStateChanges,
  turn: number,
): void {
  const attackerId = extractPayloadField<string>(envelope, 'unitId')
  const defenderId =
    extractPayloadField<string>(envelope, 'targetUnitId') ??
    extractPayloadField<string>(envelope, 'targetId')

  if (!attackerId || !defenderId) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少 unitId/targetUnitId', {}))
    return
  }
  const attacker = getEffectiveUnit(worldState, stateChanges, attackerId)
  if (!attacker) {
    events.push(makeBlockadeEvent(envelope, turn, `攻方 ${attackerId} 不存在`, { attackerId }))
    return
  }

  const outcome = resolveEngagement({
    world: worldState,
    attacker,
    defenderId,
    rng,
    sequence: envelope.sequence,
    turn,
    agentId: envelope.agentId,
  })

  events.push(...outcome.events)
  applyEngagementChanges(stateChanges, attackerId, defenderId, outcome.attackerChange, outcome.defenderChange)
}

/**
 * 结算占领节点命令。
 */
function resolveCaptureOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
  rng: DeterministicRandom,
  events: ResolutionEvent[],
  stateChanges: CombatStateChanges,
  turn: number,
): void {
  const attackerId = extractPayloadField<string>(envelope, 'unitId')
  const defenderId =
    extractPayloadField<string>(envelope, 'targetUnitId') ??
    extractPayloadField<string>(envelope, 'targetId')
  const nodeId =
    extractPayloadField<string>(envelope, 'nodeId') ??
    extractPayloadField<string>(envelope, 'node') ??
    extractPayloadField<string>(envelope, 'target')

  if (!attackerId || !nodeId) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少 unitId/nodeId', {}))
    return
  }
  const attacker = getEffectiveUnit(worldState, stateChanges, attackerId)
  if (!attacker) {
    events.push(makeBlockadeEvent(envelope, turn, `攻方 ${attackerId} 不存在`, { attackerId }))
    return
  }

  const outcome = resolveCapture({
    world: worldState,
    attacker,
    defenderId: defenderId ?? '',
    rng,
    sequence: envelope.sequence,
    turn,
    agentId: envelope.agentId,
    nodeId,
  })

  events.push(...outcome.events)
  if (defenderId) {
    applyEngagementChanges(stateChanges, attackerId, defenderId, outcome.attackerChange, outcome.defenderChange)
  } else {
    const existing = stateChanges.unitUpdates[attackerId] ?? {}
    stateChanges.unitUpdates[attackerId] = { ...existing, ...outcome.attackerChange }
  }

  if (outcome.captured) {
    stateChanges.objectiveChanges.push({ nodeId, toFactionId: attacker.factionId })
  }
}

/**
 * 结算补给命令。
 */
function resolveResupplyOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
  _rng: DeterministicRandom,
  events: ResolutionEvent[],
  stateChanges: CombatStateChanges,
  turn: number,
): void {
  const unitId = extractPayloadField<string>(envelope, 'unitId')
  if (!unitId) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少 unitId', {}))
    return
  }
  const unit = getEffectiveUnit(worldState, stateChanges, unitId)
  if (!unit) {
    events.push(makeBlockadeEvent(envelope, turn, `单位 ${unitId} 不存在`, { unitId }))
    return
  }

  const resupplied = applyResupply(unit)
  const existing = stateChanges.unitUpdates[unitId] ?? {}
  stateChanges.unitUpdates[unitId] = {
    ...existing,
    fuel: resupplied.fuel,
    ammo: resupplied.ammo,
  }
  events.push({
    id: `evt:${envelope.sequence}:resupply:0`,
    source: 'physics',
    turn,
    sequence: envelope.sequence,
    agentId: envelope.agentId,
    kind: 'resupply',
    description: `${unitId} 完成补给`,
    data: {
      unitId,
      fuelBefore: unit.fuel,
      fuelAfter: resupplied.fuel,
      ammoBefore: unit.ammo,
      ammoAfter: resupplied.ammo,
    },
  })
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 给所有单位应用回合基线消耗（油/弹/疲劳恢复）。
 * 返回增量 map（不直接修改 worldState）。
 */
function applyBaselineToAll(
  worldState: WorldState,
  _turn: number,
): Record<string, Partial<{ fuel: number; ammo: number; fatigue: number }>> {
  const updates: Record<string, Partial<{ fuel: number; ammo: number; fatigue: number }>> = {}
  for (const unit of worldState.units) {
    if (isAnnihilated(unit)) continue
    const baseline = computeBaselineConsumption(unit)
    updates[unit.id] = {
      fuel: Math.max(0, unit.fuel - baseline.fuelCost),
      ammo: Math.max(0, unit.ammo - baseline.ammoCost),
      fatigue: Math.max(0, Math.min(100, unit.fatigue + baseline.fatigueDelta)),
    }
  }
  return updates
}

/**
 * 合并基线变更与命令变更（命令变更优先）。
 */
function mergeBaseline(
  existing: Record<string, unknown>,
  baseline: Partial<{ fuel: number; ammo: number; fatigue: number }>,
): Record<string, unknown> {
  // 命令已写入的字段优先（命令结算基于 baseline 后的值，已在 getEffectiveUnit 中体现）
  return {
    fuel: existing.fuel ?? baseline.fuel,
    ammo: existing.ammo ?? baseline.ammo,
    fatigue: existing.fatigue ?? baseline.fatigue,
    ...stripUndefined(existing),
  }
}

/** 移除 undefined 字段 */
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * 应用交战变更增量（攻守双方），并处理歼灭/士气衍生。
 */
function applyEngagementChanges(
  stateChanges: CombatStateChanges,
  attackerId: string,
  defenderId: string,
  attackerChange: Record<string, unknown>,
  defenderChange: Record<string, unknown>,
): void {
  // 攻方
  const attackerExisting = stateChanges.unitUpdates[attackerId] ?? {}
  stateChanges.unitUpdates[attackerId] = { ...attackerExisting, ...attackerChange }

  // 守方
  const defenderExisting = stateChanges.unitUpdates[defenderId] ?? {}
  stateChanges.unitUpdates[defenderId] = { ...defenderExisting, ...defenderChange }

  // 歼灭判定（基于守方变更后 strength）
  const defenderFinal = stateChanges.unitUpdates[defenderId]
  if (defenderFinal?.strength !== undefined && Number(defenderFinal.strength) <= 0) {
    if (!stateChanges.annihilated.includes(defenderId)) {
      stateChanges.annihilated.push(defenderId)
    }
  }
}

/**
 * 构造一个受阻/失败事件。
 */
function makeBlockadeEvent(
  envelope: ActionEnvelope,
  turn: number,
  reason: string,
  extra: Record<string, unknown>,
): ResolutionEvent {
  return {
    id: `evt:${envelope.sequence}:blockade:0`,
    source: 'physics',
    turn,
    sequence: envelope.sequence,
    agentId: envelope.agentId,
    kind: 'blockade',
    description: `命令失败：${reason}`,
    data: { intent: envelope.intent, reason, ...extra },
  }
}

// 注：simulateTurn 已用 export function 声明（见上方），可直接供主线程/测试调用（不拉起 Worker）。

// 重新导出类型供 worker-service 引用
export type { ResolutionResult, ResolutionEvent, CombatStateChanges } from '@/layers/domain/combat'

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

import type { WorldState, ActionEnvelope, IntelObservation, IntelLevel, Unit } from '@/types'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import {
  resolveEngagement,
  resolveCapture,
  extractPayloadField,
  extractCoord,
} from '@/layers/domain/combat'
import { refreshOnRecon } from '@/layers/domain/intelligence'
import {
  applyResupply,
  computeBaselineConsumption,
  resolveMovement,
  getCellAt,
  isAnnihilated,
  SEVERED_SUPPLY_MULTIPLIER,
} from '@/layers/domain/physics-rules'
import {
  computeSupplyConnectivity,
  applySupplyState,
} from '@/layers/domain/supply'
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
 * - 'recon' / 'scout'：{ unitId, target: {col,row} | "col,row" | targetUnitId }
 *   侦察执行单位 unitId 派往 target 坐标或目标敌方单位，命中后调
 *   refreshOnRecon 升级该方对目标 cell 内敌方单位的情报等级（不伪造：无敌方单位则空发现）。
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
  // 第 4 批：基线消耗同时按补给连通性 ×SEVERED_SUPPLY_MULTIPLIER，
  //         并产出 supply_cut / supply_restored 事件（上回合 vs 本回合连通性翻转）。
  const baselineResult = applyBaselineToAll(worldState, turn)
  const baselineUpdates = baselineResult.updates
  // 补给事件先入流（sequence 段位 2500-2999，与命令 0-1999、director 3000+ 区分）
  events.push(...baselineResult.events)

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
      case 'recon':
        resolveReconOrder(worldState, envelope, rng, events, stateChanges, turn)
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
function normalizeIntent(intent: string): 'move' | 'attack' | 'capture' | 'resupply' | 'recon' | 'other' {
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
  // 主动侦察/间谍：recon/scout/spy/spot 等别名归一为 recon
  if (lower === 'recon' || lower === 'reconnaissance' || lower === 'scout' || lower === 'spy' || lower === 'spot' || lower === 'probe') {
    return 'recon'
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
 *
 * 第 4 批：补给命令前先检查单位的补给连通性（computeSupplyConnectivity）。
 * 若不连通（敌方占据其补给线路径）→ 拒绝补给（push 'supply_blocked' 事件，不 +25），
 * 体现"补给车队无法抵达被切断的单位"。连通时正常 +25（applyResupply）。
 *
 * 不伪造：连通性仅据 map.supplyNetwork 判定；无网络时恒连通（兼容旧行为）。
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

  // 第 4 批：连通性检查——补给车队需沿 supplyNetwork 抵达该单位。
  const conn = computeSupplyConnectivity(worldState.map, worldState.units, unit.factionId)
  const unitConn = conn.get(unit.id)
  const connected = unitConn ? unitConn.connected : true

  if (!connected) {
    // 不连通：拒绝补给（不 +25），push 'supply_blocked'
    events.push({
      id: `evt:${envelope.sequence}:supply_blocked:0`,
      source: 'physics',
      turn,
      sequence: envelope.sequence,
      agentId: envelope.agentId,
      kind: 'supply_blocked',
      description: `${unitId} 补给被阻断，补给车队无法抵达（blockedAt: ${unitConn?.blockedAt ?? '?'})`,
      data: {
        unitId,
        factionId: unit.factionId,
        blockedAt: unitConn?.blockedAt ?? null,
        sources: unitConn?.sources ?? [],
      },
    })
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

/**
 * 结算侦察命令（recon / scout）。
 *
 * 设计（重写计划「第 1 批：主动侦察/间谍」）：
 * - 侦察执行单位 unitId 派往目标 cell（payload.target）或目标敌方单位（payload.targetUnitId）。
 * - observer = envelope.faction（侦察执行方 factionId）。
 * - 命中目标 cell 内的**敌方单位**（factionId !== observer），逐个调
 *   {@link refreshOnRecon} 升级 observer 对该单位的情报等级：
 *     - recon 类型单位：gainedLevel = 当前 +2（封顶 L3）。
 *     - 其他类型单位：gainedLevel = 当前 +1（封顶 L3），且有 0.7 成功率
 *       （非专业侦察单位侦察能力有限，失败则该目标不刷新但仍记 event）。
 * - 把 detection 增量写入 stateChanges.unitUpdates[enemyId].detection[observer]
 *   + intelReconHits 追加。
 * - push 'recon' ResolutionEvent（data: reconUnit/targetCell/discovered[]/levelsGained[]）。
 * - **不伪造**：目标 cell 无敌方单位 → discovered=[] 空发现（绝不编造）。
 * - **确定性**：成功率判定用注入的 rng（DeterministicRandom.fromSequence）。
 *
 * 失败分支（缺 unitId/单位不存在/无目标）→ push blockade 事件（与 move/attack 一致）。
 */
function resolveReconOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
  rng: DeterministicRandom,
  events: ResolutionEvent[],
  stateChanges: CombatStateChanges,
  turn: number,
): void {
  const observer = envelope.faction
  const reconUnitId = extractPayloadField<string>(envelope, 'unitId')
  if (!reconUnitId) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少侦察单位 unitId', {}))
    return
  }
  const reconUnit = getEffectiveUnit(worldState, stateChanges, reconUnitId)
  if (!reconUnit) {
    events.push(makeBlockadeEvent(envelope, turn, `侦察单位 ${reconUnitId} 不存在`, { unitId: reconUnitId }))
    return
  }
  // 侦察单位必须属执行方（防 envelope.faction 与 unitId 不一致）
  if (reconUnit.factionId !== observer) {
    events.push(makeBlockadeEvent(envelope, turn, `侦察单位 ${reconUnitId} 不属 ${observer} 阵营`, {
      unitId: reconUnitId,
      unitFaction: reconUnit.factionId,
      observer,
    }))
    return
  }

  // 解析目标：targetCoord（payload.target）优先；否则 targetUnitId 定位其所在 cell
  const targetCoord = extractCoord(envelope, 'target')
  const targetUnitId = extractPayloadField<string>(envelope, 'targetUnitId')

  // 确定要侦察的目标 cell（用于「找该 cell 上的敌方单位」）
  let reconCellCoord: { col: number; row: number } | null = targetCoord ?? null
  let explicitTargetUnitId: string | null = null
  if (reconCellCoord === null && targetUnitId) {
    // 目标单位所在 cell
    const targetUnit = worldState.units.find((u) => u.id === targetUnitId)
    if (targetUnit) {
      reconCellCoord = { ...targetUnit.coord }
      explicitTargetUnitId = targetUnitId
    }
  }
  if (reconCellCoord === null) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少侦察目标（target 坐标或 targetUnitId）', {
      unitId: reconUnitId,
    }))
    return
  }

  // 找目标 cell 上的敌方单位（factionId !== observer）
  const isProfessionalRecon = reconUnit.type === 'recon'
  const enemiesInCell = worldState.units.filter(
    (u) =>
      u.factionId !== observer &&
      u.coord.col === reconCellCoord!.col &&
      u.coord.row === reconCellCoord!.row,
  )

  const discovered: string[] = []
  const levelsGained: Array<{ unitId: string; beforeLevel: number; afterLevel: number }> = []
  // detectionDelta：unitId → { observer → 刷新后的完整 IntelObservation }
  // 落入 event.data 供回放精确重建（含 lastSeenTurn/staleTurns，不靠推断）。
  const detectionDelta: Record<string, Record<string, IntelObservation>> = {}

  for (const enemy of enemiesInCell) {
    // 当前观测记录（缺失则视为 L0 盲区，构造初始观测）
    const curObs: IntelObservation =
      enemy.detection[observer] ?? {
        level: 0 as IntelLevel,
        lastSeenTurn: -1,
        staleTurns: 0,
      }

    // 成功率判定（确定性随机）：专业 recon 单位 100% 成功，其他 0.7
    if (!isProfessionalRecon) {
      const roll = rng.nextFloat()
      if (roll > 0.7) {
        // 侦察未命中该单位：不计入 discovered，但仍可继续尝试同 cell 其他单位
        continue
      }
    }

    // 获得的情报级别：recon 单位 +2，其他 +1，封顶 L3
    const gain = isProfessionalRecon ? 2 : 1
    const gainedLevel = Math.min(3, curObs.level + gain) as IntelLevel
    const refreshed = refreshOnRecon(curObs, turn, gainedLevel)

    // 写入 stateChanges.unitUpdates[enemy.id].detection[observer]
    const existingUpd = stateChanges.unitUpdates[enemy.id] ?? {}
    const existingDet =
      (existingUpd.detection as Record<string, IntelObservation> | undefined) ?? {}
    stateChanges.unitUpdates[enemy.id] = {
      ...existingUpd,
      detection: { ...existingDet, [observer]: refreshed },
    }

    // 同步到 detectionDelta（落 event.data 供回放重建）
    if (!detectionDelta[enemy.id]) detectionDelta[enemy.id] = {}
    detectionDelta[enemy.id][observer] = refreshed

    // 追加 reconHits 流
    if (!stateChanges.intelReconHits) stateChanges.intelReconHits = []
    stateChanges.intelReconHits.push({ observerFactionId: observer, unitId: enemy.id })

    discovered.push(enemy.id)
    levelsGained.push({
      unitId: enemy.id,
      beforeLevel: curObs.level,
      afterLevel: refreshed.level,
    })
  }

  // 侦察事件（即便无发现也记，表示该单位本回合执行了侦察动作）
  events.push({
    id: `evt:${envelope.sequence}:recon:0`,
    source: 'physics',
    turn,
    sequence: envelope.sequence,
    agentId: envelope.agentId,
    kind: 'recon',
    description:
      discovered.length > 0
        ? `${reconUnitId} 侦察 (${reconCellCoord.col},${reconCellCoord.row})：发现 ${discovered.length} 个敌方单位`
        : `${reconUnitId} 侦察 (${reconCellCoord.col},${reconCellCoord.row})：未发现敌方单位`,
    data: {
      reconUnit: reconUnitId,
      observer,
      targetCell: { col: reconCellCoord.col, row: reconCellCoord.row },
      targetUnitId: explicitTargetUnitId ?? undefined,
      discovered,
      levelsGained,
      professionalRecon: isProfessionalRecon,
      // 完整 detection 增量（unitId → observer → IntelObservation），供回放精确重建
      detectionDelta,
    },
  })
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 补给事件专用 sequence 段位（第 4 批）。
 *
 * - 2500..2998：supply_cut / supply_restored（每单位本回合翻转占一槽，按 i 偏移）。
 *   与命令（0..1999）、director（3000+）、随机事件（4001+）、决策覆写（4010+）互斥，
 *   保证同回合 event id 唯一（event-log 主键契约）。
 */
const SEQUENCE_SUPPLY_BASE = 2500

/**
 * applyBaselineToAll 返回结构（第 4 批扩展）。
 */
interface BaselineResult {
  /** 单位数值增量（fuel/ammo/fatigue/status/morale） */
  updates: Record<string, Partial<{ fuel: number; ammo: number; fatigue: number; status: Unit['status']; morale: number }>>
  /** 本回合产出的补给事件（supply_cut / supply_restored） */
  events: ResolutionEvent[]
}

/**
 * 给所有单位应用回合基线消耗（油/弹/疲劳恢复）+ 补给连通性影响（第 4 批）。
 *
 * 流程：
 * 1. 对每个阵营调 computeSupplyConnectivity（纯函数 BFS）。
 * 2. 对每个活单位：
 *    - supplyMultiplier = 连通 ? 1.0 : SEVERED_SUPPLY_MULTIPLIER。
 *    - computeBaselineConsumption(unit, supplyMultiplier) 算基线（切断则 ×2）。
 *    - applySupplyState：切断时加 low_supply + morale -5（连通时不动）。
 *    - 翻转检测：上回合是否切断（用 unit.status 含 'low_supply' 作代理信号），
 *      与本回合连通性比较，产出 supply_cut（上连→本断）/ supply_restored（上断→本连）。
 *
 * 不修改 worldState（不可变产出）。返回增量 + 事件，由 simulateTurn 合并。
 *
 * 确定性：computeSupplyConnectivity 纯函数，事件 sequence 按单位遍历顺序稳定分配。
 */
function applyBaselineToAll(
  worldState: WorldState,
  turn: number,
): BaselineResult {
  const updates: BaselineResult['updates'] = {}
  const events: ResolutionEvent[] = []

  // 按阵营分组预计算连通性（避免重复 BFS）
  const factionIds = new Set(worldState.units.map((u) => u.factionId))
  const connectivityByFaction = new Map<string, Map<string, import('@/layers/domain/supply').SupplyConnectivity>>()
  for (const fid of factionIds) {
    connectivityByFaction.set(fid, computeSupplyConnectivity(worldState.map, worldState.units, fid))
  }

  let supplyEvtIndex = 0
  for (const unit of worldState.units) {
    if (isAnnihilated(unit)) continue

    const conn = connectivityByFaction.get(unit.factionId)
    const unitConn = conn?.get(unit.id)
    const connected = unitConn ? unitConn.connected : true // 缺省连通（无网络时）

    // 1. 基线消耗（切断则 ×SEVERED_SUPPLY_MULTIPLIER）
    const mult = connected ? 1.0 : SEVERED_SUPPLY_MULTIPLIER
    const baseline = computeBaselineConsumption(unit, mult)

    // 2. applySupplyState：切断加 low_supply + morale -5
    const supplyChange = applySupplyState(unit, connected)

    updates[unit.id] = {
      fuel: Math.max(0, unit.fuel - baseline.fuelCost),
      ammo: Math.max(0, unit.ammo - baseline.ammoCost),
      fatigue: Math.max(0, Math.min(100, unit.fatigue + baseline.fatigueDelta)),
      ...(supplyChange.status !== undefined ? { status: supplyChange.status } : {}),
      ...(supplyChange.morale !== undefined ? { morale: supplyChange.morale } : {}),
    }

    // 3. 翻转检测：用 unit.status 含 'low_supply' 作为"上回合被切断"代理。
    const wasSevered = unit.status.includes('low_supply')
    if (!connected && !wasSevered) {
      // 上回合连通 → 本回合切断
      const sequence = SEQUENCE_SUPPLY_BASE + supplyEvtIndex
      supplyEvtIndex += 1
      events.push({
        id: `evt:${sequence}:supply_cut:0`,
        source: 'physics',
        turn,
        sequence,
        kind: 'supply_cut',
        description: `${unit.id} 补给线被切断，物资加速消耗`,
        data: {
          unitId: unit.id,
          factionId: unit.factionId,
          sources: unitConn?.sources ?? [],
          blockedAt: unitConn?.blockedAt ?? null,
          fuelCostMult: mult,
          moralePenalty: 5,
        },
      })
    } else if (connected && wasSevered) {
      // 上回合切断 → 本回合恢复
      const sequence = SEQUENCE_SUPPLY_BASE + supplyEvtIndex
      supplyEvtIndex += 1
      events.push({
        id: `evt:${sequence}:supply_restored:0`,
        source: 'physics',
        turn,
        sequence,
        kind: 'supply_restored',
        description: `${unit.id} 补给线恢复畅通`,
        data: {
          unitId: unit.id,
          factionId: unit.factionId,
          sources: unitConn?.sources ?? [],
        },
      })
    }
  }

  return { updates, events }
}

/**
 * 合并基线变更与命令变更（命令变更优先）。
 *
 * 第 4 批：基线变更现在也可能含 status（low_supply）/ morale（切断惩罚），
 * 与 fuel/ammo/fatigue 同样以 `existing ?? baseline` 语义合并——命令结算
 * 涉及的字段优先，基线只补未触及字段。
 */
function mergeBaseline(
  existing: Record<string, unknown>,
  baseline: Partial<{ fuel: number; ammo: number; fatigue: number; status: Unit['status']; morale: number }>,
): Record<string, unknown> {
  // 命令已写入的字段优先（命令结算基于 baseline 后的值，已在 getEffectiveUnit 中体现）
  return {
    fuel: existing.fuel ?? baseline.fuel,
    ammo: existing.ammo ?? baseline.ammo,
    fatigue: existing.fatigue ?? baseline.fatigue,
    morale: existing.morale ?? baseline.morale,
    status: existing.status ?? baseline.status,
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

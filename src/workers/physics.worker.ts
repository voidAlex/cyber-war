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
  checkRoutAndSurrender,
} from '@/layers/domain/combat'
import { refreshOnRecon } from '@/layers/domain/intelligence'
import {
  applyResupply,
  computeBaselineConsumption,
  resolveMovement,
  getCellAt,
  isAnnihilated,
  SEVERED_SUPPLY_MULTIPLIER,
  NIGHT_MODIFIERS,
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
 * - 'hold'：{ unitId }（就地固守设防，不移动；士气+恢复、疲劳-恢复，地形防御×1.5 留痕）
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
      case 'hold':
        resolveHoldOrder(worldState, envelope, events, stateChanges, turn)
        break
      case 'entrench':
        resolveEntrenchOrder(worldState, envelope, events, stateChanges, turn)
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
    // T1-A：cellUpdates 是单元格增量（非单位），单独合并到 stateChanges.cellUpdates。
    if (unitId === 'cellUpdates') continue
    const existing = stateChanges.unitUpdates[unitId] ?? {}
    stateChanges.unitUpdates[unitId] = mergeBaseline(existing, baseline)
  }
  // T1-A：合并 baseline 的 cellUpdates（废弃工事衰减）到 stateChanges.cellUpdates。
  // 命令（entrench）已写入的 cell.fortificationLevel 优先（不被衰减覆盖）。
  const baselineCellUpdates = baselineUpdates.cellUpdates
  if (baselineCellUpdates) {
    if (!stateChanges.cellUpdates) stateChanges.cellUpdates = {}
    for (const [cellId, cellUpd] of Object.entries(baselineCellUpdates)) {
      // 命令未触及该 cell 才写衰减；命令已写 fortificationLevel 则保留命令值
      if (stateChanges.cellUpdates[cellId] === undefined) {
        stateChanges.cellUpdates[cellId] = { ...cellUpd }
      }
    }
  }

  // T1-D：所有 intent 处理后，检查溃退/投降（基于结算后单位数值）。
  // 构造一个"结算后视图"：worldState 的单位叠加 stateChanges 增量（ morale/strength/coord/status），
  // 让 checkRoutAndSurrender 看到的是本回合战斗后的真实状态（如被攻击后 morale 跌破 15 → 溃退）。
  // 歼灭单位（annihilated）已不在视图内（被过滤），不参与判定。
  applyRoutAndSurrender(worldState, events, stateChanges, turn)

  return {
    turn,
    events,
    stateChanges,
    success: true,
  }
}

/**
 * T1-D：在 simulateTurn 末尾调用 checkRoutAndSurrender，产出 rout/surrender 事件并合并 stateChanges。
 *
 * 构造"结算后视图"：把 worldState.units 叠加 stateChanges.unitUpdates（数值字段），
 * 过滤掉已歼灭单位，喂给 checkRoutAndSurrender。产出的 routs/surrenders：
 * - routs：合并到 stateChanges.unitUpdates（coord/strength/status），push 'rout' 事件。
 * - surrenders：合并到 stateChanges.unitUpdates（strength=0），加入 stateChanges.annihilated，
 *   push 'surrender' 事件。
 *
 * 事件 sequence 段位 2600-2699（与 supply 2500-2998、director 3000+ 区分，保证 event id 唯一）。
 */
function applyRoutAndSurrender(
  worldState: WorldState,
  events: ResolutionEvent[],
  stateChanges: CombatStateChanges,
  turn: number,
): void {
  // 构造结算后视图（叠加 stateChanges 增量 + 过滤歼灭单位）
  const annihilatedSet = new Set(stateChanges.annihilated)
  const postUnits: Unit[] = []
  for (const unit of worldState.units) {
    if (annihilatedSet.has(unit.id)) continue
    const upd = stateChanges.unitUpdates[unit.id]
    if (!upd) {
      postUnits.push(unit)
      continue
    }
    const merged: Unit = { ...unit }
    if (upd.morale !== undefined) merged.morale = upd.morale
    if (upd.strength !== undefined) merged.strength = upd.strength
    if (upd.coord !== undefined) merged.coord = upd.coord
    if (upd.status !== undefined) merged.status = upd.status
    if (upd.fatigue !== undefined) merged.fatigue = upd.fatigue
    if (upd.fuel !== undefined) merged.fuel = upd.fuel
    if (upd.ammo !== undefined) merged.ammo = upd.ammo
    postUnits.push(merged)
  }
  const postWorld: WorldState = { ...worldState, units: postUnits }

  const result = checkRoutAndSurrender(postWorld)

  // 溃退：合并到 stateChanges + push 'rout' 事件
  let evtIndex = 0
  for (const rout of result.routs) {
    const existing = stateChanges.unitUpdates[rout.id] ?? {}
    stateChanges.unitUpdates[rout.id] = {
      ...existing,
      coord: rout.coord,
      strength: rout.strength,
      status: rout.status,
    }
    const sequence = 2600 + evtIndex
    evtIndex += 1
    events.push({
      id: `evt:${sequence}:rout:0`,
      source: 'physics',
      turn,
      sequence,
      kind: 'rout',
      description: `${rout.id} 士气崩溃，向己方后方溃退`,
      data: {
        unitId: rout.id,
        coord: rout.coord,
        strengthAfter: rout.strength,
        status: rout.status,
      },
    })
  }

  // 投降：合并到 stateChanges（strength=0）+ 加入 annihilated + push 'surrender' 事件
  for (const sur of result.surrenders) {
    const existing = stateChanges.unitUpdates[sur.id] ?? {}
    stateChanges.unitUpdates[sur.id] = {
      ...existing,
      strength: 0,
      status: sur.status,
    }
    if (!stateChanges.annihilated.includes(sur.id)) {
      stateChanges.annihilated.push(sur.id)
    }
    const sequence = 2600 + evtIndex
    evtIndex += 1
    events.push({
      id: `evt:${sequence}:surrender:0`,
      source: 'physics',
      turn,
      sequence,
      kind: 'surrender',
      description: `${sur.id} 弹尽粮绝被包围，放下武器投降`,
      data: {
        unitId: sur.id,
        strengthAfter: 0,
        status: sur.status,
      },
    })
  }
}

// ============================================================================
// 各 intent 结算
// ============================================================================

/**
 * 归一化 intent 字符串到内部类别。
 */
function normalizeIntent(
  intent: string,
): 'move' | 'attack' | 'capture' | 'resupply' | 'recon' | 'hold' | 'entrench' | 'other' {
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
  // T1-A：entrench 单独归一（"构筑"/"挖战壕"/"设防"/"加固"/"entrench"/"dig in"/"fortify"）。
  // 旧版 normalizeIntent 曾把 'entrench'/'dig_in' 误归到 hold；现拆出独立分支，
  // 让 resolveEntrenchOrder 处理（entrenchment +1 + cell.fortificationLevel 提升）。
  if (
    lower === 'entrench' ||
    lower === 'dig_in' ||
    lower === 'dig-in' ||
    lower === 'fortify' ||
    lower === '构筑' ||
    lower === '挖战壕' ||
    lower === '设防' ||
    lower === '加固'
  ) {
    return 'entrench'
  }
  // Bug2 修复：hold/defend/stand/guard 等归一为 hold（原映射缺失，hold 命令落到 other → unsupported）。
  if (lower === 'hold' || lower === 'defend' || lower === 'stand' || lower === 'guard') {
    return 'hold'
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
  let targetCoord = extractCoord(envelope, 'target') ?? extractCoord(envelope, 'destination')

  if (!unitId) {
    events.push(makeBlockadeEvent(envelope, turn, '缺少 unitId', {}))
    return
  }
  const unit = getEffectiveUnit(worldState, stateChanges, unitId)
  if (!unit) {
    events.push(makeBlockadeEvent(envelope, turn, `单位 ${unitId} 不存在`, { unitId }))
    return
  }

  // Bug1 修复：payload.target 缺失时，用 targetUnitId 所在单位坐标兜底（追击/靠拢敌军语义）。
  // 根因（真机日志）：chief LLM 解析了单位但漏解析坐标 → envelope payload.target 为空 →
  // 直接 blockade「缺少目标坐标」，单位永远无法移动。兜底坐标取自 world 真实敌方单位，绝不伪造。
  if (!targetCoord) {
    const targetUnitId =
      extractPayloadField<string>(envelope, 'targetUnitId') ??
      extractPayloadField<string>(envelope, 'targetId')
    if (targetUnitId) {
      const targetUnit = worldState.units.find((u) => u.id === targetUnitId)
      if (targetUnit) {
        targetCoord = { ...targetUnit.coord }
      }
    }
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

  // T1-B/C：天气 + 日夜 modifier 放大燃料消耗。
  // - weather.modifiers.movementCostMult（rain 1.5 / storm 2 / snow 2.5）。
  // - timeOfDay==='night' 时再 ×NIGHT_MODIFIERS.fuelCostMult（1.2）。
  // 仅放大成功/受阻的实际消耗（不变更 success 判定，避免天气让机动完全失败）。
  const weatherMoveMult = worldState.weather?.modifiers?.movementCostMult ?? 1
  const nightMoveMult =
    worldState.timeOfDay === 'night' ? NIGHT_MODIFIERS.fuelCostMult : 1
  const fuelCostMult = weatherMoveMult * nightMoveMult
  const adjustedFuelCost =
    fuelCostMult !== 1 ? Math.round(result.fuelCost * fuelCostMult) : result.fuelCost

  // 合并变更增量
  const existing = stateChanges.unitUpdates[unitId] ?? {}
  if (result.success) {
    stateChanges.unitUpdates[unitId] = {
      ...existing,
      fuel: Math.max(0, unit.fuel - adjustedFuelCost),
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
        fuelCost: adjustedFuelCost,
        fatigueGain: result.fatigueGain,
        terrain: targetCell.terrain,
        weatherMoveMult,
        nightMoveMult,
      },
    })
  } else {
    // 受阻/燃料不足：仍扣部分燃料与疲劳（按 modifier 放大）
    stateChanges.unitUpdates[unitId] = {
      ...existing,
      fuel: Math.max(0, unit.fuel - adjustedFuelCost),
      fatigue: Math.min(100, unit.fatigue + result.fatigueGain),
    }
    events.push(makeBlockadeEvent(envelope, turn, result.reason ?? '机动失败', {
      unitId,
      target: targetCoord,
      fuelCost: adjustedFuelCost,
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
 * Bug2 修复：结算固守命令（hold / defend）。
 *
 * 原根因（真机日志）：hold 命令落到 simulateTurn default 分支 → `unsupported` blockade，
 * 单位"原地不动且无任何数值变化"，玩家下达 hold 等于空操作。
 *
 * 固守语义：单位就地设防，不产生位移（coord 不变），但有数值变化：
 * - **防御提升**：基于当前所在 cell 的地形 defenseBonus ×1.5（就地设防加成）。
 *   体现方式：通过 status 标记（'engaged'→'pinned' 链路不适用，hold 不改 status，
 *   而是把地形加成隐含在后续交战结算的 defenderCell.defenseBonus 中，由物理层
 *   在 attack/capture 时读取；此处 hold 仅产出事件留痕 + 数值恢复，不改 defense 字段
 *   ——Unit 无独立 defense 字段，defenseBonus 属 cell）。
 * - **补给基线消耗**：固守不机动但仍维持警戒，消耗基线 fuel/ammo（与 applyBaselineToAll
 *   一致，但 baseline 已在第一遍统一扣，此处不再重复扣 fuel/ammo，避免双扣）。
 * - **士气小幅恢复**：休整 +morale（+2，封顶 100）。体现"停止行军/作战 → 部队喘息"。
 * - **疲劳小幅恢复**：fatigue -3（下限 0）。固守比机动省力。
 *
 * 产出 `action_executed` 事件（kind='hold'），记录单位 id + coord + morale/fatigue 变化。
 * 不产生位移（coord 字段不写入 stateChanges）。
 *
 * 确定性：纯数值计算，无随机数（hold 不涉及概率判定）。
 */
function resolveHoldOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
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

  // 取单位当前所在 cell 的地形 defenseBonus（用于事件留痕 + 后续交战隐含加成说明）。
  // 找不到 cell 时 defenseBonus 兜底 0（平原基准），绝不阻断结算。
  const cell = getCellAt(worldState.map, unit.coord.col, unit.coord.row)
  const terrainDefense = cell?.defenseBonus ?? 0
  // 就地设防加成：地形防御 ×1.5（固守工事强化）。仅事件留痕，不改 Unit 字段
  // （Unit 无 defense 字段，defenseBonus 属 cell，attack 结算时读 cell 即可）。
  const holdDefenseBonus = terrainDefense * 1.5

  // 士气恢复 +2（休整），封顶 100。基于 baseline 后的 morale（getEffectiveUnit 已含 baseline）。
  const moraleAfter = Math.min(100, unit.morale + HOLD_MORALE_RECOVERY)
  // 疲劳恢复 -3（固守比机动省力），下限 0。
  const fatigueAfter = Math.max(0, unit.fatigue - HOLD_FATIGUE_RECOVERY)

  // 合并变更增量（不写 coord —— 固守不移动）。
  const existing = stateChanges.unitUpdates[unitId] ?? {}
  stateChanges.unitUpdates[unitId] = {
    ...existing,
    morale: moraleAfter,
    fatigue: fatigueAfter,
  }

  events.push({
    id: `evt:${envelope.sequence}:hold:0`,
    source: 'physics',
    turn,
    sequence: envelope.sequence,
    agentId: envelope.agentId,
    kind: 'hold',
    description: `${unitId} 在 (${unit.coord.col},${unit.coord.row}) 就地固守设防`,
    data: {
      unitId,
      coord: { ...unit.coord },
      terrain: cell?.terrain ?? 'plain',
      terrainDefenseBonus: terrainDefense,
      holdDefenseBonus,
      moraleBefore: unit.morale,
      moraleAfter,
      fatigueBefore: unit.fatigue,
      fatigueAfter,
    },
  })
}

/** 固守回合士气恢复量（休整加成）。 */
const HOLD_MORALE_RECOVERY = 2
/** 固守回合疲劳恢复量（比机动省力）。 */
const HOLD_FATIGUE_RECOVERY = 3

// =============================================================================
// T1-A：entrench（构筑工事/战壕）结算
// =============================================================================

/** 工事等级上限（entrenchment 与 cell.fortificationLevel 共用）。 */
const ENTRENCHMENT_MAX_LEVEL = 3
/** 构筑工事回合士气加成（专注工事、巩固防线）。 */
const ENTRENCH_MORALE_GAIN = 2

/**
 * 结算构筑工事命令（entrench / dig_in / fortify / 构筑 / 挖战壕 / 设防 / 加固）。
 *
 * 语义（T1-A）：单位就地不动，专注构筑野战工事。
 * - unit.entrenchment = min(3, current+1)（每回合 +1，封顶 3）。
 * - cell.fortificationLevel = unit 新 entrenchment（同步提升该格工事等级，
 *   单位离开后 cell 工事残留，applyBaselineToAll 末尾按无驻留衰减 -1）。
 * - morale +2（专注工事、巩固防线，与 hold 的休整语义互补）。
 * - 不写 coord（不移动）；不扣额外燃料/弹药（基线已扣）。
 * - 产出 'entrench' 事件（kind='entrench'，记录前后 entrenchment/cell 工事等级）。
 *
 * 确定性：纯数值计算，无随机数。combat 结算时 computeEffectiveDefense 读取
 * unit.entrenchment 与 cell.fortificationLevel 给防御加成（每级 +0.15/+0.1）。
 */
function resolveEntrenchOrder(
  worldState: WorldState,
  envelope: ActionEnvelope,
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

  // 取单位当前所在 cell（用于同步 cell.fortificationLevel）
  const cell = getCellAt(worldState.map, unit.coord.col, unit.coord.row)

  // entrenchment +1（封顶 3）；缺省视为 0
  const beforeLevel = Math.max(0, unit.entrenchment ?? 0)
  const afterLevel = Math.min(ENTRENCHMENT_MAX_LEVEL, beforeLevel + 1)

  // morale +2（封顶 100）
  const moraleAfter = Math.min(100, unit.morale + ENTRENCH_MORALE_GAIN)

  // 合并单位变更（不写 coord —— 构筑工事不移动）
  const existing = stateChanges.unitUpdates[unitId] ?? {}
  stateChanges.unitUpdates[unitId] = {
    ...existing,
    entrenchment: afterLevel,
    morale: moraleAfter,
  }

  // 同步 cell.fortificationLevel = 新 entrenchment（单位把工事留在该格）
  if (cell) {
    if (!stateChanges.cellUpdates) stateChanges.cellUpdates = {}
    const existingCell = stateChanges.cellUpdates[cell.id] ?? {}
    stateChanges.cellUpdates[cell.id] = {
      ...existingCell,
      fortificationLevel: afterLevel,
    }
  }

  events.push({
    id: `evt:${envelope.sequence}:entrench:0`,
    source: 'physics',
    turn,
    sequence: envelope.sequence,
    agentId: envelope.agentId,
    kind: 'entrench',
    description: `${unitId} 在 (${unit.coord.col},${unit.coord.row}) 构筑工事（等级 ${beforeLevel}→${afterLevel}）`,
    data: {
      unitId,
      coord: { ...unit.coord },
      entrenchmentBefore: beforeLevel,
      entrenchmentAfter: afterLevel,
      cellId: cell?.id ?? null,
      fortificationLevel: afterLevel,
      moraleBefore: unit.morale,
      moraleAfter,
      terrain: cell?.terrain ?? 'plain',
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
    // T1-C：night 时 gainedLevel -1（夜间观测困难，最低 L0）。
    // T1-B：天气 visibilityPenalty（负值）再降级 |penalty| level（fog -2 / storm -1 / snow -1）。
    // 两者叠加，但 gainedLevel 下限为 max(0, curObs.level)（不降级到比当前更低，避免侦察反而降级情报）。
    const nightPenalty = worldState.timeOfDay === 'night' ? NIGHT_MODIFIERS.reconLevelPenalty : 0
    const weatherPenalty = Math.abs(worldState.weather?.modifiers?.visibilityPenalty ?? 0)
    const totalPenalty = nightPenalty + weatherPenalty
    const rawLevel = curObs.level + gain - totalPenalty
    // 下限：不低于当前观测 level（侦察不应降级情报），且不低于 L0；上限封顶 L3
    const finalLevel = Math.min(
      3,
      Math.max(curObs.level, Math.max(0, rawLevel)),
    ) as IntelLevel
    const refreshed = refreshOnRecon(curObs, turn, finalLevel)

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
 * applyBaselineToAll 返回结构（第 4 批扩展 + T1-A 单元格增量）。
 */
interface BaselineResult {
  /** 单位数值增量（fuel/ammo/fatigue/status/morale） */
  updates: Record<
    string,
    Partial<{
      fuel: number
      ammo: number
      fatigue: number
      status: Unit['status']
      morale: number
    }>
  > & {
    /** T1-A：单元格增量（cellId → Partial<MapCell>，废弃工事衰减用）。 */
    cellUpdates?: Record<string, Partial<import('@/types').MapCell>>
  }
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

  // T1-A：废弃工事衰减。遍历所有 cell，若 cell.fortificationLevel > 0 且该格无任何单位驻留
  // → fortificationLevel -1（野战工事无人维护每回合衰减一级，最低 0）。
  // 产出 cellUpdates 增量（不产事件——衰减是静默的基线效果，避免事件流噪音）。
  // 注意：有单位驻留的格不衰减（单位在此格时工事被持续维护；单位离开后下一回合才衰减）。
  const occupiedCells = new Set<string>()
  for (const unit of worldState.units) {
    if (isAnnihilated(unit)) continue
    // 单位当前 coord 对应 cell.id（用 "col:row" 格式匹配 map.cells[].id 风格）
    // map.cells 的 id 格式不统一（"col:row" 或 "cell-col-row"），用 col/row 直接匹配更稳：
    occupiedCells.add(`${unit.coord.col}:${unit.coord.row}`)
  }
  for (const cell of worldState.map.cells) {
    const level = Math.max(0, cell.fortificationLevel ?? 0)
    if (level <= 0) continue
    // 该格是否被任何单位占据（用 col/row 匹配，兼容多种 cell.id 格式）
    const isOccupied = occupiedCells.has(`${cell.col}:${cell.row}`)
    if (isOccupied) continue
    // 无驻留 → 衰减 -1
    if (!updates.cellUpdates) {
      ;(updates as BaselineResult['updates']).cellUpdates = {}
    }
    updates.cellUpdates[cell.id] = { fortificationLevel: Math.max(0, level - 1) }
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

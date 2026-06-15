/**
 * 回放（replay.ts）— 从 snapshot + event-log 恢复到任意状态（验收#7 红线）。
 *
 * **确定性两层分明**（TDD §3.1 + 重写计划修订决策#7）：
 *
 * 1. 物理层（source:'physics'）：用 `DeterministicRandom(scenarioSeed:turn:sequence)`
 *    **重算**物理结果，与 event-log 记录值比对；不一致 → 记 driftWarning（不中断）。
 * 2. 导演层（source:'director' / source:'rule-engine'）：**直接从 log 读原文采信，
 *    不重算**（LLM/规则引擎产物不可复现，验收#7 核心）。
 *
 * 回放对 event-log 的处理（两类事件，确定性两层各司其职）：
 * - physics 类：把记录的 ResolutionEvent.data 应用到 baseWorld（产出与当时一致的
 *   WorldState）；同时用相同 seed 公式重算关键数值字段，比对一致（漂移则告警）。
 * - director / rule-engine 类：战报/覆写原文直接采信；覆写数值（director overrides）
 *   按 payload 中的应用值落到 world（采信 log，不重算）。
 *
 * 损坏恢复：调用方先取最近 snapshot 作 baseWorld（见 snapshot.ts readSnapshot），
 * 再把其后 events 传 restoreFromEventLog 重放。
 *
 * @module layers/persistence/replay
 */

import type {
  AgentAction,
  WorldState,
  Unit,
  MapCell,
  DriftWarning,
  RestoreResult,
  IntelObservation,
} from '@/types'
import type { ResolutionEvent, ResolutionEventKind, CombatStateChanges } from '@/layers/domain/combat'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import {
  resolveDamage,
  resolveMovement,
  getCellAt,
  computeBaselineConsumption,
} from '@/layers/domain/physics-rules'

// =============================================================================
// 主入口：restoreFromEventLog
// =============================================================================

/**
 * 从 event-log 重放到指定状态（验收#7 红线）。
 *
 * 处理流程：
 * 1. 从 baseWorld 深拷贝出 workingWorld（不可变产出，不污染输入）。
 * 2. 逐条处理 events，按 source 分流：
 *    - physics：应用 ResolutionEvent 的 stateChanges 增量到 workingWorld；
 *      同时用 seed 重算数值字段比对（漂移记 DriftWarning，不中断）。
 *    - director / rule-engine：采信原文；若有 override/数值变更，按 log 值落到 world。
 * 3. 推进 workingWorld.turnIndex 到 events 最大 turn（回放对齐）。
 * 4. 返回 { world, driftWarnings }。
 *
 * **二次回放一致性**：相同 (baseWorld, events, scenarioSeed) → 相同结果（纯函数）。
 *
 * @param events event-log 条目（AgentAction[]，可跨回合）
 * @param baseWorld 回放起点世界状态（建议取最近 snapshot）
 * @param scenarioSeed 场景固定种子（用于重算 seed：scenarioSeed:turn:sequence）
 */
export function restoreFromEventLog(
  events: AgentAction[],
  baseWorld: WorldState,
  scenarioSeed: string,
): RestoreResult {
  // 1. 深拷贝 baseWorld，避免污染输入（回放是只读语义对输入 baseWorld 而言）
  const world = structuredClone(baseWorld)
  const driftWarnings: DriftWarning[] = []
  // 顺序应用的物理 stateChanges（跟踪中间单位状态，供逐条重算用）
  const stateChanges: CombatStateChanges = {
    unitUpdates: {},
    annihilated: [],
    objectiveChanges: [],
  }

  // 2. 按回合分组处理（与 physics.worker 的 simulateTurn 同构）。
  //    worker 语义：基线消耗从回合开始状态算，命令结算基于「未应用基线」的单位视图，
  //    最后用 `existing ?? baseline` 合并（命令涉及的字段优先，基线仅填补未涉及字段）。
  //    回放严格复现此顺序，保证 fuel/ammo/fatigue 与原运行一致。
  const turns = sortedUniqueTurns(events)
  for (const turn of turns) {
    // 2a. 计算本回合基线消耗（从回合开始的 world.units 算，不立即应用）
    const baseline = computeTurnBaseline(world)
    // 2b. 物理类事件按原序处理（重算校验 + 应用增量）。
    //     命令结算基于未应用基线的单位视图（与 worker getEffectiveUnit 在
    //     applyBaselineToAll 后但 baseline 未合并进 unitUpdates 时一致）。
    for (const action of eventsForTurn(events, turn)) {
      if (action.source !== 'physics') continue
      const evt = agentActionToResolutionEvent(action)
      if (!evt) continue
      const warnings = recomputeAndVerify(evt, world, stateChanges, scenarioSeed)
      driftWarnings.push(...warnings)
      applyResolutionEvent(world, stateChanges, evt)
    }
    // 2c. 合并基线（仅填补命令未涉及字段，与 worker mergeBaseline 同构）+ 提交物理变更回 world.units
    mergeBaselineIntoChanges(stateChanges, baseline)
    commitStateChanges(world, stateChanges)
    // 2d. 导演层类事件（director / rule-engine）采信应用：覆写数值直接落到已提交的 world
    //     （director 覆写在原流程中作用于物理结算后的最终状态，故在此提交后应用）。
    for (const action of eventsForTurn(events, turn)) {
      if (action.source === 'physics') continue
      applyTrustedAction(world, action)
    }
  }

  // 3. 推进 turnIndex：event-log 中最大 turn 表示该回合已结算完毕，
  //    与原运行一致（simulateTurn 后 advanceTurn 推进 turnIndex += 1），
  //    故回放结束 turnIndex = maxTurn + 1（最大已结算回合的下一回合）。
  const maxTurn = events.reduce((m, e) => Math.max(m, e.turn), -1)
  if (maxTurn >= 0) {
    world.turnIndex = Math.max(world.turnIndex, maxTurn + 1)
  }

  return { world, driftWarnings }
}

// =============================================================================
// 损坏恢复：从 snapshot + event-log 重放（async，读 IO）
// =============================================================================

/**
 * 从最近快照 + 全量 event-log 重放到最新状态（损坏恢复入口）。
 *
 * 流程：
 * 1. readSnapshot(saveId) 取最近快照作 baseWorld；不存在则回退 world-state.json。
 * 2. readEventLog 取全量 events（分页拼接，上限 SNAPSHOT_REPLAY_MAX_EVENTS 防失控）。
 * 3. 快照 turnIndex 之后的 events 调 restoreFromEventLog 重放。
 *
 * 经 gateway 调 fs（IO 层），不直接 import @tauri-apps/api。
 *
 * @param saveId 存档 id
 * @returns 恢复的 WorldState（无快照/无事件时返回 null）
 */
export async function replayToLatest(saveId: string): Promise<RestoreResult | null> {
  // 延迟 import 避免循环依赖（snapshot/event-log 同目录）
  const { readSnapshot } = await import('./snapshot')
  const { readEventLog } = await import('./event-log')

  const snap = await readSnapshot(saveId)
  if (!snap) return null

  // 取快照 turnIndex 之后的所有事件重放（快照已是该 turn 落盘态）
  // 分页读全量（上限保护，防异常巨量日志）
  const MAX_EVENTS = 50_000
  const events: AgentAction[] = []
  const PAGE = 500
  let offset = 0
  while (events.length < MAX_EVENTS) {
    const batch = await readEventLog(saveId, offset, PAGE)
    if (batch.length === 0) break
    events.push(...batch)
    offset += batch.length
    if (batch.length < PAGE) break
  }
  // 仅回放快照 turn 之后的事件（快照已固化其 turn 的状态）
  const replayEvents = events.filter((e) => e.turn > snap.turnIndex)

  const result = restoreFromEventLog(replayEvents, snap.world, snap.scenarioSeed)
  return result
}

// =============================================================================
// 物理层重算校验（用相同 seed 公式，比对关键数值字段）
// =============================================================================

/**
 * 用 seed 重算物理事件的数值，与 log 记录值比对（漂移则记告警）。
 *
 * 重算规则（与原运行相同的 seed 公式 scenarioSeed:turn:sequence）：
 * - engagement：从中间世界状态取 attacker/defender/cell，重建 RNG 重算 resolveDamage，
 *   比对 attackerLoss / defenderLoss。
 * - movement：从中间状态取 unit/targetCell，重建 RNG 重算 resolveMovement，
 *   比对 fuelCost / fatigueGain / success。
 * - 其它（capture/casualty/resupply/blockade）：无独立随机或为衍生，跳过重算。
 *
 * 重算依赖「中间世界状态」——通过已应用的 stateChanges 还原到该事件发生前
 * 的单位视图，保证重算输入与原运行一致（确定性根）。
 */
function recomputeAndVerify(
  evt: ResolutionEvent,
  baseWorld: WorldState,
  stateChanges: CombatStateChanges,
  scenarioSeed: string,
): DriftWarning[] {
  const warnings: DriftWarning[] = []
  const seed = `${scenarioSeed}:${evt.turn}:${evt.sequence}`
  const rng = new DeterministicRandom(seed)

  try {
    if (evt.kind === 'engagement') {
      const attackerId = String(evt.data.attackerId ?? '')
      const defenderId = String(evt.data.defenderId ?? '')
      const attacker = getEffectiveUnit(baseWorld, stateChanges, attackerId)
      const defender = getEffectiveUnit(baseWorld, stateChanges, defenderId)
      if (!attacker || !defender) return warnings // 单位缺失（可能已歼灭），无法重算，不告警
      const cell = getCellAt(baseWorld.map, defender.coord.col, defender.coord.row) ?? zeroCell(defender)
      const recomputed = resolveDamage({ attacker, defender, defenderCell: cell, rng })
      // 比对 attackerLoss（= 守方承受 = attackerDealt）
      checkAndWarn(
        warnings, evt, 'defenderLoss', recomputed.attackerDealt,
        Number(evt.data.defenderLoss), seed,
      )
      checkAndWarn(
        warnings, evt, 'attackerLoss', recomputed.defenderDealt,
        Number(evt.data.attackerLoss), seed,
      )
    } else if (evt.kind === 'movement') {
      const unitId = String(evt.data.unitId ?? '')
      const unit = getEffectiveUnit(baseWorld, stateChanges, unitId)
      if (!unit) return warnings
      const to = evt.data.to as { col: number; row: number } | undefined
      if (!to) return warnings
      const targetCell = getCellAt(baseWorld.map, to.col, to.row) ?? zeroCellByCoord(to)
      const from = (evt.data.from as { col: number; row: number } | undefined) ?? unit.coord
      const distance =
        Math.abs(from.col - to.col) + Math.abs(from.row - to.row)
      if (distance <= 0) return warnings
      const recomputed = resolveMovement({
        unit,
        targetCell,
        cellsToTraverse: distance,
        rng,
      })
      // 仅当原运行成功时比对 fuelCost/fatigueGain（失败分支值不同）
      checkAndWarn(
        warnings, evt, 'fuelCost', recomputed.fuelCost,
        Number(evt.data.fuelCost), seed,
      )
      checkAndWarn(
        warnings, evt, 'fatigueGain', recomputed.fatigueGain,
        Number(evt.data.fatigueGain), seed,
      )
    }
    // capture / casualty / resupply / blockade / recon：无独立确定性随机扰动或为衍生，
    // 不单独重算（其数值已由前置 engagement/movement 校验覆盖；
    // recon 的情报级别升级采信 log 记录值，成功率随机虽用 rng 但回放不重算 discovered 集合）。
  } catch (err) {
    warnings.push({
      eventId: evt.id,
      kind: 'recompute-error',
      turn: evt.turn,
      sequence: evt.sequence,
      field: '*',
      expected: null,
      recorded: evt.data,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  return warnings
}

/**
 * 比对重算期望值与 log 记录值，不一致则记 DriftWarning。
 *
 * NaN/缺失字段视为规则漂移（log 缺数据 = 缺失告警）。
 */
function checkAndWarn(
  warnings: DriftWarning[],
  evt: ResolutionEvent,
  field: string,
  expected: unknown,
  recorded: unknown,
  seed: string,
): void {
  const expNum = typeof expected === 'number' ? expected : Number.NaN
  const recNum = typeof recorded === 'number' ? recorded : Number.NaN
  if (recorded === undefined || Number.isNaN(recNum)) {
    warnings.push({
      eventId: evt.id,
      kind: 'missing',
      turn: evt.turn,
      sequence: evt.sequence,
      field,
      expected,
      recorded,
      reason: `字段 ${field} 在 log 中缺失（seed=${seed}）`,
    })
    return
  }
  if (Number.isNaN(expNum) || expNum !== recNum) {
    warnings.push({
      eventId: evt.id,
      kind: expNum !== recNum && !Number.isNaN(expNum) ? 'rule' : 'seed',
      turn: evt.turn,
      sequence: evt.sequence,
      field,
      expected,
      recorded,
      reason: `字段 ${field} 重算值(${expected}) 与 log 记录值(${recorded}) 不一致（seed=${seed}）`,
    })
  }
}

// =============================================================================
// 物理 ResolutionEvent → stateChanges 应用（采信 log 的数值结果）
// =============================================================================

/**
 * 把物理 ResolutionEvent 的数值结果应用到 workingWorld（采信 log）。
 *
 * 与 physics.worker 的应用逻辑对齐：
 * - engagement：按 data.attackerLoss/defenderLoss 调整 strength/personnel/morale/
 *   fatigue/ammo；记录 annihilated。
 * - movement：更新 coord/fuel/fatigue。
 * - resupply：更新 fuel/ammo。
 * - capture：更新 objectiveChanges（节点归属）。
 * - casualty/blockade：衍生/失败，不单独应用（前置事件已处理）。
 */
function applyResolutionEvent(
  world: WorldState,
  stateChanges: CombatStateChanges,
  evt: ResolutionEvent,
): void {
  switch (evt.kind) {
    case 'engagement': {
      const attackerId = String(evt.data.attackerId ?? '')
      const defenderId = String(evt.data.defenderId ?? '')
      const defenderLoss = Number(evt.data.defenderLoss ?? 0)
      const attackerLoss = Number(evt.data.attackerLoss ?? 0)
      applyEngagementToChanges(world, stateChanges, attackerId, attackerLoss, true)
      applyEngagementToChanges(world, stateChanges, defenderId, defenderLoss, false)
      if (evt.data.defenderAnnihilated === true) {
        if (!stateChanges.annihilated.includes(defenderId)) {
          stateChanges.annihilated.push(defenderId)
        }
      }
      break
    }
    case 'movement': {
      const unitId = String(evt.data.unitId ?? '')
      const to = evt.data.to as { col: number; row: number } | undefined
      const fuelCost = Number(evt.data.fuelCost ?? 0)
      const fatigueGain = Number(evt.data.fatigueGain ?? 0)
      // 用 effective unit（含基线消耗增量），与 physics.worker getEffectiveUnit 对齐
      const unit = getEffectiveUnit(world, stateChanges, unitId)
      if (unit && to) {
        const existing = stateChanges.unitUpdates[unitId] ?? {}
        stateChanges.unitUpdates[unitId] = {
          ...existing,
          fuel: Math.max(0, unit.fuel - fuelCost),
          fatigue: Math.min(100, unit.fatigue + fatigueGain),
          coord: { col: to.col, row: to.row },
        }
      }
      break
    }
    case 'resupply': {
      const unitId = String(evt.data.unitId ?? '')
      const fuelAfter = evt.data.fuelAfter
      const ammoAfter = evt.data.ammoAfter
      if (fuelAfter !== undefined || ammoAfter !== undefined) {
        const existing = stateChanges.unitUpdates[unitId] ?? {}
        stateChanges.unitUpdates[unitId] = {
          ...existing,
          ...(fuelAfter !== undefined ? { fuel: Number(fuelAfter) } : {}),
          ...(ammoAfter !== undefined ? { ammo: Number(ammoAfter) } : {}),
        }
      }
      break
    }
    case 'capture': {
      const nodeId = String(evt.data.nodeId ?? '')
      const factionId = String(evt.data.factionId ?? '')
      if (nodeId && factionId) {
        stateChanges.objectiveChanges.push({ nodeId, toFactionId: factionId })
      }
      break
    }
    case 'recon': {
      // 主动侦察命中：从 event.data.detectionDelta 重建 detection 增量 + reconHits 流。
      // detectionDelta 结构：{ [unitId]: { [observerFactionId]: IntelObservation } }。
      // 采信 log 记录值（记录即真相），不重算（成功率虽用 rng，但回放采信 discovered 集合）。
      const observer = String(evt.data.observer ?? '')
      const detectionDelta = evt.data.detectionDelta as
        | Record<string, Record<string, IntelObservation>>
        | undefined
      if (detectionDelta && observer) {
        for (const [unitId, obsMap] of Object.entries(detectionDelta)) {
          const obs = obsMap[observer]
          if (!obs) continue
          const existing = stateChanges.unitUpdates[unitId] ?? {}
          const existingDet = (existing.detection as Record<string, IntelObservation>) ?? {}
          stateChanges.unitUpdates[unitId] = {
            ...existing,
            detection: { ...existingDet, [observer]: obs },
          }
          if (!stateChanges.intelReconHits) stateChanges.intelReconHits = []
          stateChanges.intelReconHits.push({ observerFactionId: observer, unitId })
        }
      }
      break
    }
    default:
      // casualty（衍生）/ blockade（失败占位）：不单独应用
      break
  }
}

/**
 * 应用交战损失到 stateChanges（strength/personnel/morale/fatigue/ammo）。
 *
 * @param world 用于反查 personnel 基数
 * @param stateChanges 增量收集器
 * @param unitId 单位 id
 * @param strengthLost 本单位本回合承受的 strength 损失
 * @param isAttacker 是否攻方（决定弹药消耗语义，此处简化统一 AMMO_PER_ENGAGEMENT）
 */
function applyEngagementToChanges(
  world: WorldState,
  stateChanges: CombatStateChanges,
  unitId: string,
  strengthLost: number,
  _isAttacker: boolean,
): void {
  // 用 effective unit（含基线消耗增量），与 physics.worker 对齐
  const unit = getEffectiveUnit(world, stateChanges, unitId)
  if (!unit) return
  const existing = stateChanges.unitUpdates[unitId] ?? {}
  const newStrength = Math.max(0, unit.strength - strengthLost)
  // 人员损失按 strength 比例折算
  const personnelLoss = Math.round(
    unit.personnel * (strengthLost / Math.max(1, unit.strength)),
  )
  // 士气按损失下降，疲劳+10，弹药-8（与 physics-rules 常量一致）
  stateChanges.unitUpdates[unitId] = {
    ...existing,
    strength: newStrength,
    personnel: Math.max(0, unit.personnel - personnelLoss),
    morale: Math.max(0, unit.morale - Math.round(strengthLost * 0.5)),
    fatigue: Math.min(100, unit.fatigue + 10),
    ammo: Math.max(0, unit.ammo - 8),
  }
}

// =============================================================================
// 导演层采信应用（director override / rule-engine 数值，直接采信 log）
// =============================================================================

/**
 * 采信 director / rule-engine 类 action：原文/覆写直接落到 world（不重算）。
 *
 * - director override（kind:'adjudication', payload.kind:'override'）：
 *   按 field 路径 units.<unitId>.<field> 应用 after 值（采信 log）。
 * - random_event（第 2 批，payload.kind:'random_event'）：
 *   从 payload.data.effects（DirectorOverride[]）逐条应用 after 值（采信 log）。
 *   reinforcement 单位已在 commitStateChanges 时由援军注入逻辑处理
 *   （援军单位 id 来自 event.data.reinforcementUnitIds，回放需另行注入）。
 * - report / 其它：原文采信，不修改 world 数值（战报进 directorMemory 留痕）。
 */
function applyTrustedAction(world: WorldState, action: AgentAction): void {
  const payloadKind = String(action.payload['kind'] ?? '')
  if (payloadKind === 'override') {
    const field = String(action.payload['field'] ?? '')
    const after = action.payload['after']
    const parsed = parseOverrideField(field)
    if (parsed && after !== undefined) {
      const unit = world.units.find((u) => u.id === parsed.unitId)
      if (unit) {
        // 采信 log 的 after 值，落到 world（不可变产出）
        setUnitField(unit, parsed.field, after)
      }
    }
    return
  }
  // 第 2 批：random_event（source:'director'，采信 log 的 effects 数组，不重算）
  if (payloadKind === 'random_event') {
    const data = (action.payload['data'] as Record<string, unknown>) ?? {}
    // 1. 注入援军单位（采信 log 的 reinforcementUnits 完整定义，不重算）
    const reinforcementUnits = (data['reinforcementUnits'] as
      | Array<Record<string, unknown>>
      | undefined)
    if (reinforcementUnits && reinforcementUnits.length > 0) {
      const existing = new Set(world.units.map((u) => u.id))
      for (const ru of reinforcementUnits) {
        const id = String(ru['id'] ?? '')
        if (!id || existing.has(id)) continue
        const coord = ru['coord'] as { col: number; row: number } | undefined
        if (!coord) continue
        world.units.push({
          id,
          factionId: String(ru['factionId'] ?? ''),
          type: String(ru['type'] ?? 'infantry') as Unit['type'],
          coord: { col: coord.col, row: coord.row },
          strength: Number(ru['strength'] ?? 0),
          personnel: Number(ru['personnel'] ?? 0),
          maxPersonnel: Number(ru['maxPersonnel'] ?? 0),
          fuel: Number(ru['fuel'] ?? 0),
          ammo: Number(ru['ammo'] ?? 0),
          morale: Number(ru['morale'] ?? 0),
          fatigue: Number(ru['fatigue'] ?? 0),
          detection: {},
          orders: [],
          status: [],
        })
        existing.add(id)
      }
    }
    // 2. 应用 effects（采信 log 的 after 值，落到 world）
    const effects = (data['effects'] as Array<Record<string, unknown>>) ?? []
    for (const eff of effects) {
      const field = String(eff['field'] ?? '')
      const after = eff['after']
      const parsed = parseOverrideField(field)
      if (parsed && after !== undefined) {
        const unit = world.units.find((u) => u.id === parsed.unitId)
        if (unit) {
          setUnitField(unit, parsed.field, after)
        }
      }
    }
    return
  }
  // rule-engine 包装的物理事件（payload.kind 为 movement/engagement 等）：
  // 采信 log 原文，不重算（rule-engine 标记本身即「采信」语义）。
  // 其数值已由生成它的物理引擎结果固化，回放不二次校验。
}

/** 解析 override field 路径 `units.<unitId>.<field>` → { unitId, field }。 */
function parseOverrideField(field: string): { unitId: string; field: string } | null {
  const parts = field.split('.')
  if (parts.length < 3) return null
  if (parts[0] !== 'units') return null
  return { unitId: parts[1], field: parts.slice(2).join('.') }
}

/**
 * 采信 log 值，把 director override 的 after 写到单位字段（不可变语义：直接赋值）。
 *
 * field 限定为 Unit 的数值字段（strength/fuel/ammo/morale/fatigue/personnel）。
 */
function setUnitField(unit: Unit, field: string, after: unknown): void {
  const record = unit as unknown as Record<string, unknown>
  record[field] = after
}

// =============================================================================
// 辅助：中间单位视图 / 歼灭移除 / 事件转换
// =============================================================================

/**
 * 取「已应用 stateChanges 增量后」的单位视图（与 physics.worker getEffectiveUnit 同构）。
 *
 * 回放重算必须用此视图——每个事件发生时的单位状态是前置事件应用后的累积态。
 */
function getEffectiveUnit(
  world: WorldState,
  stateChanges: CombatStateChanges,
  unitId: string,
): Unit | null {
  const base = world.units.find((u) => u.id === unitId)
  if (!base) return null
  const update = stateChanges.unitUpdates[unitId] ?? {}
  return { ...base, ...update }
}

/**
 * 把本回合累积的 stateChanges 提交到 world.units，并重置增量。
 *
 * - 单位数值变更（strength/personnel/fuel/ammo/morale/fatigue/coord/status）落到对应单位。
 * - 歼灭单位从 world.units 移除（与原运行 briefing 后一致）。
 * - objectiveChanges 累积记录（M4 高价值节点控制权扩展时落地到 world，此处暂存）。
 * - 重置 stateChanges，使下一回合基线从已推进状态算起。
 */
function commitStateChanges(world: WorldState, stateChanges: CombatStateChanges): void {
  // 1. 落地单位数值变更
  for (const unit of world.units) {
    const upd = stateChanges.unitUpdates[unit.id]
    if (!upd) continue
    if (upd.coord) unit.coord = upd.coord
    if (upd.fuel !== undefined) unit.fuel = upd.fuel
    if (upd.ammo !== undefined) unit.ammo = upd.ammo
    if (upd.strength !== undefined) unit.strength = upd.strength
    if (upd.personnel !== undefined) unit.personnel = upd.personnel
    if (upd.morale !== undefined) unit.morale = upd.morale
    if (upd.fatigue !== undefined) unit.fatigue = upd.fatigue
    if (upd.status) unit.status = upd.status
    // detection 增量（recon 命中）：合并 observer → IntelObservation（覆盖该观测记录）
    if (upd.detection) {
      const detDelta = upd.detection as Record<string, unknown>
      for (const [observerFactionId, observation] of Object.entries(detDelta)) {
        unit.detection[observerFactionId] = observation as IntelObservation
      }
    }
  }
  // 2. 歼灭单位移除
  if (stateChanges.annihilated.length > 0) {
    const dead = new Set(stateChanges.annihilated)
    world.units = world.units.filter((u) => !dead.has(u.id))
  }
  // 3. reconHits 流追加到 world.intel.reconHits（turn 由调用方回合上下文隐含——
  //    回放按回合分组，本回合事件 turn 即 world 当前结算回合）
  if (stateChanges.intelReconHits && stateChanges.intelReconHits.length > 0) {
    for (const hit of stateChanges.intelReconHits) {
      // 从本回合事件取 turn（commitStateChanges 不直接知 turn，用 reconHits 的隐含回合：
      // 实际 turn 由 applyResolutionEvent 调用时的 evt.turn 决定，此处用 world.turnIndex 近似）
      world.intel.reconHits.push({
        turn: world.turnIndex,
        observerFactionId: hit.observerFactionId,
        unitId: hit.unitId,
      })
    }
  }
  // 4. 重置增量（下一回合从 world 当前态起）
  stateChanges.unitUpdates = {}
  stateChanges.annihilated = []
  stateChanges.objectiveChanges = []
  stateChanges.intelReconHits = []
}

// =============================================================================
// 按回合分组辅助 + 基线消耗重放
// =============================================================================

/** 取 event-log 中出现的所有去重回合（升序）。 */
function sortedUniqueTurns(events: readonly AgentAction[]): number[] {
  const set = new Set<number>()
  for (const e of events) set.add(e.turn)
  return [...set].sort((a, b) => a - b)
}

/** 取某回合的所有事件（保持原相对顺序）。 */
function eventsForTurn(events: readonly AgentAction[], turn: number): AgentAction[] {
  return events.filter((e) => e.turn === turn)
}

/**
 * 计算本回合基线消耗（从回合开始的 world.units 算，与 worker applyBaselineToAll 同构）。
 *
 * 返回 unitId → 基线后数值（fuel/ammo/fatigue），不立即应用到 stateChanges；
 * 由 mergeBaselineIntoChanges 在命令结算后用 `??` 语义合并。
 */
function computeTurnBaseline(
  world: WorldState,
): Record<string, { fuel: number; ammo: number; fatigue: number }> {
  const out: Record<string, { fuel: number; ammo: number; fatigue: number }> = {}
  for (const unit of world.units) {
    if (unit.strength <= 0) continue
    const b = computeBaselineConsumption(unit)
    out[unit.id] = {
      fuel: Math.max(0, unit.fuel - b.fuelCost),
      ammo: Math.max(0, unit.ammo - b.ammoCost),
      fatigue: Math.max(0, Math.min(100, unit.fatigue + b.fatigueDelta)),
    }
  }
  return out
}

/**
 * 把基线合并进 stateChanges（仅填补命令未涉及字段，与 worker mergeBaseline 同构）。
 *
 * 语义：`existing.field ?? baseline.field`——命令结算涉及的字段优先，
 * 基线只补充未被任何命令触及的单位/字段（如无指令的 red-1 的每回合 -2 fuel）。
 */
function mergeBaselineIntoChanges(
  stateChanges: CombatStateChanges,
  baseline: Record<string, { fuel: number; ammo: number; fatigue: number }>,
): void {
  for (const [unitId, b] of Object.entries(baseline)) {
    const existing = stateChanges.unitUpdates[unitId] ?? {}
    stateChanges.unitUpdates[unitId] = {
      ...existing,
      fuel: existing.fuel ?? b.fuel,
      ammo: existing.ammo ?? b.ammo,
      fatigue: existing.fatigue ?? b.fatigue,
    }
  }
}

/** 兜底零防御单元（defenderCell 找不到时，与 combat.ts 同构）。 */
function zeroCell(unit: Unit): MapCell {
  return {
    id: `${unit.coord.col}:${unit.coord.row}`,
    col: unit.coord.col,
    row: unit.coord.row,
    terrain: 'plain',
    movementCost: 1,
    defenseBonus: 0,
    isObjective: false,
  }
}

/** 兜底零防御单元（按坐标）。 */
function zeroCellByCoord(coord: { col: number; row: number }): MapCell {
  return {
    id: `${coord.col}:${coord.row}`,
    col: coord.col,
    row: coord.row,
    terrain: 'plain',
    movementCost: 1,
    defenseBonus: 0,
    isObjective: false,
  }
}

/**
 * 把 physics 类 AgentAction 转回 ResolutionEvent（取 payload 嵌套的 event 数据）。
 *
 * event-log 中 physics 类 AgentAction 的 payload 形如
 * { kind: ResolutionEventKind, description: string, data: Record<string, unknown> }，
 * 其余字段（id/turn/sequence）直接取自 AgentAction。
 *
 * @returns ResolutionEvent；非 physics 或结构不完整时返回 null
 */
function agentActionToResolutionEvent(action: AgentAction): ResolutionEvent | null {
  const kind = action.payload['kind'] as ResolutionEventKind | undefined
  if (!kind) return null
  const data = (action.payload['data'] as Record<string, unknown>) ?? {}
  return {
    id: action.id,
    source: 'physics',
    turn: action.turn,
    sequence: action.sequence,
    agentId: action.agentId,
    kind,
    description: String(action.payload['description'] ?? action.text ?? ''),
    data,
  }
}

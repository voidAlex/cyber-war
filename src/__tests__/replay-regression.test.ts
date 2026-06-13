/**
 * 回放回归测试（replay-regression.test.ts）— 验收#7 红线。
 *
 * 验证「回放从日志恢复而非重新调 LLM」+「确定性两层分明」：
 * 1. 构造固定 scenarioSeed，用真实物理引擎（simulateTurn 纯函数）跑 3 回合，
 *    director 产物固定（mock），收集 event-log（physics + director 分源）。
 * 2. 回放 restoreFromEventLog：
 *    - 物理层重算与 log 一致（无 driftWarning）。
 *    - director 战报/覆写与 log 原文一致（从 log 读，未重算）。
 *    - 最终 WorldState 关键字段（turn/units strength/coord/factions）与原运行一致。
 * 3. 二次回放一致性：相同 event-log 两次回放结果完全一致。
 * 4. 漂移检测：人为篡改一条 physics event 数值 → 回放应产出 driftWarning。
 *
 * @module __tests__/replay-regression
 */

import { describe, it, expect } from 'vitest'
import { simulateTurn } from '@/workers/physics.worker'
import type {
  WorldState,
  Unit,
  MapCell,
  AgentAction,
} from '@/types'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import { restoreFromEventLog } from '@/layers/persistence/replay'

// ============================================================================
// 测试世界构造（含玩家/敌方单位 + 地图，凡尔登量级简化）
// ============================================================================

const SCENARIO_SEED = 'verdun-1916:replay-test'

function makeCells(cols: number, rows: number): MapCell[] {
  const cells: MapCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        id: `${col}:${row}`,
        col,
        row,
        terrain: 'plain',
        movementCost: 1,
        defenseBonus: 0,
        isObjective: false,
      })
    }
  }
  return cells
}

function makeUnit(overrides: Partial<Unit>): Unit {
  return {
    id: 'u',
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

function makeWorld(): WorldState {
  const cells = makeCells(5, 5)
  const units: Unit[] = [
    makeUnit({ id: 'blue-1', factionId: 'blue', type: 'armor', coord: { col: 0, row: 0 } }),
    makeUnit({ id: 'blue-2', factionId: 'blue', type: 'infantry', coord: { col: 1, row: 0 } }),
    makeUnit({ id: 'red-1', factionId: 'red', type: 'infantry', coord: { col: 4, row: 4 } }),
  ]
  return {
    saveId: 'replay-save',
    scenarioId: 'verdun-1916',
    scenarioSeed: SCENARIO_SEED,
    turnIndex: 0,
    inGameDate: 'D-0',
    factions: [
      {
        id: 'blue', name: '蓝', color: '#00F', side: 'player',
        commander: { id: 'cb', name: 'cb', personality: '', aggression: 0.5, obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [] },
        theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [],
      },
      {
        id: 'red', name: '红', color: '#F00', side: 'enemy',
        commander: { id: 'cr', name: 'cr', personality: '', aggression: 0.7, obedience: 0.6, preferredTempo: 'rapid', doctrineTags: [] },
        theaterCommanders: [], supply: { supplies: 70, ammunition: 70, fuel: 70 }, trust: {}, doctrineTags: [],
      },
    ],
    units,
    map: {
      gridType: 'square', cols: 5, rows: 5, cells,
      highValueNodes: [{ id: 'fort', name: '堡垒', cellId: '2:2', controlThreshold: 1 }],
    },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [], lockedOrders: {}, lastResolution: null, contextSummaries: {},
  }
}

// ============================================================================
// 锁定命令构造（chief 段 0+，sequence 预分配）
// ============================================================================

import { buildEnvelope } from '@/layers/application/orchestrator/handshake-flow'
import type { ActionEnvelope } from '@/types'

function makeLockedOrders(turn: number): ActionEnvelope[] {
  // 每回合一条蓝方 attack 命令（blue-1 攻击 red-1）+ 一条蓝方 move 命令
  return [
    buildEnvelope({
      turn,
      faction: 'blue',
      agentId: `chief-blue-${turn}`,
      intent: 'attack',
      payload: { unitId: 'blue-1', targetUnitId: 'red-1' },
      sequence: 0,
    }),
    buildEnvelope({
      turn,
      faction: 'blue',
      agentId: `chief-blue-${turn}`,
      intent: 'move',
      payload: { unitId: 'blue-2', target: { col: 2, row: 1 } },
      sequence: 1,
    }),
  ]
}

// ============================================================================
// director mock 产物（固定战报，与 director.ts physicsEventsToAgentActions 同构）
// ============================================================================

/**
 * 把物理 ResolutionEvent 转为 physics 类 AgentAction（与 director mock 同构）。
 *
 * 这是 event-log 中 physics 条目的真实形态（payload 含 kind/description/data）。
 */
function physicsEventsToAgentActions(
  events: readonly ResolutionEvent[],
  scenarioSeed: string,
  turn: number,
): AgentAction[] {
  return events.map((evt) => ({
    id: evt.id,
    turn,
    agentId: 'director-physics',
    agentRole: 'director',
    kind: 'adjudication',
    source: 'physics',
    payload: { kind: evt.kind, description: evt.description, data: evt.data },
    text: evt.description,
    sequence: evt.sequence,
    seed: `${scenarioSeed}:${turn}:${evt.sequence}`,
  }))
}

/**
 * 构造一条固定的 director 战报 AgentAction（source:'director'，回放采信不重算）。
 *
 * 用 director 段位末尾固定槽 3000+998（与 director.ts reportToDirectorAction 对齐）。
 */
function makeDirectorReportAction(turn: number, reportText: string): AgentAction {
  const sequence = 3000 + 998
  return {
    id: `evt:${sequence}:director-report:0`,
    turn,
    agentId: 'director-llm',
    agentRole: 'director',
    kind: 'report',
    source: 'director',
    payload: { kind: 'report', keyEvents: [] },
    text: reportText,
    sequence,
    seed: `${SCENARIO_SEED}:${turn}:${sequence}`,
  }
}

/**
 * 把物理结算结果应用到 world（与 physics.worker stateChanges 应用对齐，供原运行推进用）。
 *
 * 此函数仅用于「原运行」推进世界状态，回放路径独立用 restoreFromEventLog。
 */
function applyResolutionToWorld(world: WorldState, result: ResolutionResult): void {
  const { unitUpdates, annihilated, objectiveChanges } = result.stateChanges
  for (const unit of world.units) {
    const upd = unitUpdates[unit.id]
    if (upd) {
      if (upd.coord) unit.coord = upd.coord
      if (upd.fuel !== undefined) unit.fuel = upd.fuel
      if (upd.ammo !== undefined) unit.ammo = upd.ammo
      if (upd.strength !== undefined) unit.strength = upd.strength
      if (upd.personnel !== undefined) unit.personnel = upd.personnel
      if (upd.morale !== undefined) unit.morale = upd.morale
      if (upd.fatigue !== undefined) unit.fatigue = upd.fatigue
      if (upd.status) unit.status = upd.status
    }
  }
  world.units = world.units.filter((u) => !annihilated.includes(u.id))
  // objectiveChanges 暂不落地到 world（M4 高价值节点控制权扩展时补）
  void objectiveChanges
  world.turnIndex += 1
}

// ============================================================================
// 跑 3 回合原运行，收集 event-log + 最终 world 快照
// ============================================================================

function runOriginalThreeTurns(): {
  baseWorld: WorldState
  finalWorld: WorldState
  eventLog: AgentAction[]
  perTurnResults: ResolutionResult[]
} {
  const baseWorld = makeWorld()
  const world = structuredClone(baseWorld)
  const eventLog: AgentAction[] = []
  const perTurnResults: ResolutionResult[] = []

  for (let turn = 0; turn < 3; turn++) {
    const locked = makeLockedOrders(turn)
    const result = simulateTurn(world, locked, SCENARIO_SEED, turn)
    perTurnResults.push(result)

    // 物理事件落 log（source:'physics'）
    const physicsActions = physicsEventsToAgentActions(result.events, SCENARIO_SEED, turn)
    eventLog.push(...physicsActions)

    // director 固定战报落 log（source:'director'，mock 固定）
    const report = makeDirectorReportAction(turn, `第 ${turn + 1} 天战报：蓝方持续推进（mock 固定）`)
    eventLog.push(report)

    // 推进世界状态（原运行）
    applyResolutionToWorld(world, result)
  }

  return { baseWorld, finalWorld: world, eventLog, perTurnResults }
}

// ============================================================================
// 测试用例
// ============================================================================

describe('回放回归（验收#7：回放从日志恢复而非重新调 LLM）', () => {
  it('物理层重算与 log 一致（无 driftWarning），最终 WorldState 与原运行一致', () => {
    const { baseWorld, finalWorld, eventLog } = runOriginalThreeTurns()

    // 回放：从 baseWorld + event-log 恢复
    const { world: replayed, driftWarnings } = restoreFromEventLog(
      eventLog,
      baseWorld,
      SCENARIO_SEED,
    )

    // 物理层重算无漂移（physics 类事件重算与 log 一致）
    expect(driftWarnings).toHaveLength(0)

    // 最终 turnIndex 一致
    expect(replayed.turnIndex).toBe(finalWorld.turnIndex)

    // 关键单位字段一致（strength/coord）
    for (const originalUnit of finalWorld.units) {
      const replayedUnit = replayed.units.find((u) => u.id === originalUnit.id)
      expect(replayedUnit, `单位 ${originalUnit.id} 应存在`).toBeDefined()
      expect(replayedUnit!.strength).toBe(originalUnit.strength)
      expect(replayedUnit!.coord).toEqual(originalUnit.coord)
      expect(replayedUnit!.fuel).toBe(originalUnit.fuel)
    }

    // 阵营一致
    expect(replayed.factions.map((f) => f.id).sort()).toEqual(
      finalWorld.factions.map((f) => f.id).sort(),
    )
  })

  it('director 战报/覆写与 log 原文一致（从 log 读，未重算）', () => {
    const { baseWorld, eventLog } = runOriginalThreeTurns()

    const { world: replayed } = restoreFromEventLog(eventLog, baseWorld, SCENARIO_SEED)

    // 回放后 world.turnIndex 与 event-log 最大 turn 对齐（3 回合 → turnIndex 3）
    expect(replayed.turnIndex).toBe(3)

    // director 战报原文采信：event-log 中所有 director 类 action 的 text 保持原文
    const directorReports = eventLog.filter(
      (e) => e.source === 'director' && e.kind === 'report',
    )
    expect(directorReports.length).toBe(3)
    for (const report of directorReports) {
      expect(report.text).toContain('mock 固定')
    }

    // 回放未引入新的 director 事件（采信 log，不重算 director）
    // （回放产物只对 world 数值，不重建 event-log；此断言确认 log 原文未变）
    expect(eventLog.filter((e) => e.source === 'director')).toHaveLength(3)
  })

  it('二次回放一致性：相同 event-log 两次回放结果完全一致', () => {
    const { baseWorld, eventLog } = runOriginalThreeTurns()

    const r1 = restoreFromEventLog(structuredClone(eventLog), structuredClone(baseWorld), SCENARIO_SEED)
    const r2 = restoreFromEventLog(structuredClone(eventLog), structuredClone(baseWorld), SCENARIO_SEED)

    // 漂移告警一致
    expect(r1.driftWarnings).toEqual(r2.driftWarnings)

    // world 完全一致（深比较）
    expect(r1.world).toEqual(r2.world)
  })

  it('漂移检测：篡改一条 physics event 数值 → 回放产出 driftWarning', () => {
    const { baseWorld, eventLog } = runOriginalThreeTurns()

    // 找到第一条 engagement 事件，篡改其 defenderLoss（守方损失）
    const tamperedLog = structuredClone(eventLog)
    const engagementAction = tamperedLog.find(
      (a) => a.source === 'physics' && a.payload['kind'] === 'engagement',
    )
    expect(engagementAction, '应至少有一条 engagement 物理事件').toBeDefined()
    const data = engagementAction!.payload['data'] as Record<string, unknown>
    // 篡改为一个明显不可能的值（原始重算值必然不同）
    data['defenderLoss'] = 9999

    const { driftWarnings } = restoreFromEventLog(tamperedLog, baseWorld, SCENARIO_SEED)

    // 回放应捕获漂移（defenderLoss 重算值 ≠ 9999）
    expect(driftWarnings.length).toBeGreaterThan(0)
    const defenderLossWarn = driftWarnings.find((w) => w.field === 'defenderLoss')
    expect(defenderLossWarn, '应产出 defenderLoss 漂移告警').toBeDefined()
    expect(defenderLossWarn!.recorded).toBe(9999)
    expect(defenderLossWarn!.expected).not.toBe(9999)
  })

  it('director override 数值采信落 world（不重算）', () => {
    const { baseWorld, eventLog } = runOriginalThreeTurns()

    // 追加一条 director override：把 blue-1.strength 改为 42（导演部覆写留痕）
    const overrideLog = structuredClone(eventLog)
    overrideLog.push({
      id: 'evt:3000:director-override:0',
      turn: 2,
      agentId: 'director-llm',
      agentRole: 'director',
      kind: 'adjudication',
      source: 'director',
      payload: {
        kind: 'override',
        field: 'units.blue-1.strength',
        before: 50,
        after: 42,
        reason: '导演部裁定：补给中断削弱战力',
      },
      text: '[导演部覆写] units.blue-1.strength',
      sequence: 3000,
      seed: `${SCENARIO_SEED}:2:3000`,
    })

    const { world: replayed, driftWarnings } = restoreFromEventLog(
      overrideLog,
      baseWorld,
      SCENARIO_SEED,
    )

    // director override 不产生物理漂移告警（采信不重算）
    const physicsWarnings = driftWarnings.filter((w) => w.field === 'strength')
    expect(physicsWarnings).toHaveLength(0)

    // override 的 after 值（42）应落到 world（采信 log）
    const blue1 = replayed.units.find((u) => u.id === 'blue-1')
    expect(blue1, 'blue-1 应存在').toBeDefined()
    expect(blue1!.strength).toBe(42)
  })
})

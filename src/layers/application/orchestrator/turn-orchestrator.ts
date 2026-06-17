/**
 * 回合编排器（turn-orchestrator.ts）— 显式 service 函数（非 React effect）。
 *
 * 对应重写计划关键防坑「effect 闘包竞态 → 显式 service 函数（非巨型 effect），
 * 用 AbortController 而非 cancelled 标志」与「persist 被 UI 跳过 → advanceTurn
 * 中落盘 await（非 fire-and-forget）」。
 *
 * 职责：编排一个完整回合的状态机推进 + 副作用（落盘/LLM/Worker）。
 * 集中处理 locked → resolution → briefing → persist → idle 全链路，
 * persist 阶段 await services.persistence.writeTurn + 追加事件，
 * 成功后才 PERSIST_COMPLETE → NEXT_TURN。
 *
 * M2 增强 resolution：services.resolve 可注入物理引擎结算（Worker）+ 导演部终裁（mock）。
 * 默认 createDefaultResolver 接 PhysicsEngineClient.simulateTurn + director.adjudicate，
 * 战报从 ResolutionResult.events 拼装（M3 换真流式 LLM）。
 *
 * UI 推进按钮必须走本编排器，禁直接 dispatch NEXT_TURN。
 *
 * @module layers/application/orchestrator/turn-orchestrator
 */

import type {
  AgentAction,
  GamePhase,
  ResolutionSummary,
  WorldState,
  CampaignRules,
  TacticalDecision,
  TacticalDecisionTemplate,
} from '@/types'
import type {
  StateMachineContext,
  StateMachineAction,
} from '@/layers/application/state-machine/types'
import { wegoReducer } from '@/layers/application/state-machine/reducer'
import type { PersistenceService } from '@/layers/application/services/persistence-service'
import type { PhysicsEngineClient } from '@/layers/application/services/worker-service'
import type { ResolutionResult } from '@/layers/domain/combat'
import { applyResolutionStateChanges } from '@/layers/domain/combat'
import { evaluateVictory } from '@/layers/domain/victory'
import type { DirectorRole, ContextCompressor } from '@/layers/agents/roles/director'
import { SEQUENCE_DIRECTOR_DECISION_OVERRIDE_BASE } from '@/layers/agents/roles/director'
import { shouldCompressContext } from '@/layers/agents/roles/context-compression'
import { appendDiagnostic } from '@/layers/persistence/diagnostics'
import { logger } from '@/utils/logger'

/**
 * 编排器所需的副作用服务句柄（依赖注入，便于 mock 测试）。
 */
export interface TurnOrchestratorServices {
  /** 持久化服务（world-state 原子写 + event-log 追加） */
  persistence: PersistenceService
  /**
   * 结算服务（M1 空回合产出空 ResolutionResult；M2+ 接入物理/Agent）。
   * 返回 { resolution, events }。M1 events 为空数组。
   *
   * 默认实现（createDefaultResolver）：locked → resolution 时调
   * workerService.simulateTurn(world, lockedOrders, seed) 得物理结果，
   * 再经 director.adjudicate（mock 透传）产出战报与事件。
   */
  resolve?: (ctx: StateMachineContext, signal: AbortSignal) => Promise<{
    resolution: ResolutionSummary
    events: AgentAction[]
    /**
     * 可选：结算后应用了情报增量（detection/reconHits）的新 world。
     * resolver 在结算 recon 命中后注入（调 applyResolutionToIntel），
     * 让 briefing 阶段 UI 立即看到被侦察区域的敌方 level 提升（无需 reload）。
     * 缺失时 advanceTurn 沿用原 world。
     */
    world?: WorldState
    /**
     * M4-D 上下文压缩产物（可选，每 5 回合）。
     * 仅当 shouldCompressContext(turn) 时由 resolver 注入：
     * 含 { turn, text }，编排器据此在 FINISH_RESOLUTION 更新 worldState.contextSummaries。
     * 压缩事件已包含在 events 中（source:'rule-engine'，回放采信）。
     */
    contextSummary?: { turn: number; text: string }
    /**
     * 第 3 批：本回合触发的战术决策（可选）。
     *
     * resolver 内部（导演部 adjudicate）按 rules.decisions 模板产出。
     * 编排器据此在 FINISH_RESOLUTION 后决定路径：
     * - 有 pendingDecision：OFFER_DECISION 挂起（briefing → decision），等玩家选择；
     * - 无 pendingDecision：直接 ENTER_PERSIST（briefing → persist）。
     */
    pendingDecision?: TacticalDecision
  }>
}

/** advanceTurn 取消时抛出的错误类型标记 */
export const TURN_CANCELLED = 'TURN_CANCELLED'

/** advanceTurn 落盘失败时抛出的错误类型标记 */
export const TURN_PERSIST_FAILED = 'TURN_PERSIST_FAILED'

/**
 * 回合推进结果。
 */
export interface AdvanceTurnResult {
  /** 推进后的新上下文 */
  context: StateMachineContext
  /** 编排过程中 dispatch 的全部 action（调试/日志用） */
  actions: StateMachineAction[]
  /**
   * 第 3 批：是否在 decision 阶段挂起（等玩家选择战术决策）。
   *
   * - true：context.game.phase === 'decision'，context.pendingDecision 已填充。
   *   调用方（store）应展示 DecisionPanel，等玩家 RESOLVE_DECISION 后
   *   调 resumeTurnAfterDecision 完成本回合（decision → persist → idle → NEXT_TURN）。
   * - false（默认）：本回合已完整推进到下一 idle（无决策或已跳过）。
   */
  pausedAtDecision?: boolean
  /**
   * 第 3 批：decision 阶段挂起时的「挂起句柄」。
   *
   * 仅当 pausedAtDecision=true 时存在。携带 resumeTurnAfterDecision 所需的运行时状态
   * （本回合已结算但未落盘的 events + 回合号），不进 reducer/context（保持纯函数边界）。
   * 调用方（store）应在 RESOLVE_DECISION 后把它原样传给 resumeTurnAfterDecision。
   */
  decisionHandle?: DecisionResumeHandle
}

/**
 * 第 3 批：decision 阶段挂起后的恢复句柄（advanceTurn 暂停时返回，resume 时消费）。
 *
 * 携带本回合已结算但未落盘的运行时状态（events + turn + scenarioSeed），
 * 供 resumeTurnAfterDecision 在玩家选择后完成 persist → idle → NEXT_TURN。
 *
 * 不进 reducer/context（瞬态运行时数据，落盘仅经 events）。
 */
export interface DecisionResumeHandle {
  /** 本回合已结算但未落盘的事件（physics + director + random_events） */
  events: AgentAction[]
  /** 本回合号（落盘日志上下文用） */
  turn: number
  /** 场景种子（决策后果事件 seed 用） */
  scenarioSeed: string
}

/**
 * 内部：dispatch 一个 action 到 reducer，返回新上下文；守卫失败时抛错。
 *
 * 使用 AbortController.signal：已取消时抛 TURN_CANCELLED。
 */
function step(
  ctx: StateMachineContext,
  action: StateMachineAction,
  signal: AbortSignal,
): StateMachineContext {
  if (signal.aborted) {
    throw Object.assign(new Error('turn-orchestrator: 已取消'), {
      code: TURN_CANCELLED,
    })
  }
  const result = wegoReducer(ctx, action)
  if (!result.ok) {
    throw new Error(`turn-orchestrator: 守卫拒绝 ${action.type}：${result.error}`)
  }
  return result.state
}

/**
 * 推进一个完整回合（空转闭环）。
 *
 * M1 空回合链路（从 planning 起步）：
 *   planning → handshake → locked → resolution → briefing → persist →
 *   （await writeTurn 落盘）→ idle → NEXT_TURN（turnIndex+1）
 *
 * 预期进入时的 ctx.game.phase 为 planning（由 UI「开始规划」按钮先 START_TURN 进入）。
 * 若直接从 idle 调用，会先内部 START_TURN 进入 planning 再继续。
 *
 * persist 阶段 await services.persistence.writeTurn(world, phase, events)
 * （非 fire-and-forget），落盘成功后才 PERSIST_COMPLETE → NEXT_TURN。
 * 落盘失败时回退到 briefing 并抛 TURN_PERSIST_FAILED（不进下一回合）。
 *
 * 落盘语义（关键）：writeTurn 落盘的 world-state/manifest turnIndex = N+1
 * （下一回合 idle 态），而非结算回合 N——保证刷新（loadSave）后显示正确回合。
 * 内存 reducer 流程不变（PERSIST_COMPLETE→NEXT_TURN 仍在内存推进 turnIndex+1），
 * 落盘的 turnIndex 数值仅影响 world-state.json 快照，回放从 event-log 重算不受影响。
 *
 * @param ctx 当前状态机上下文
 * @param services 副作用服务句柄
 * @param signal AbortSignal，用于取消（默认新建）
 * @returns 推进后的新上下文与 dispatch 序列
 */
export async function advanceTurn(
  ctx: StateMachineContext,
  services: TurnOrchestratorServices,
  signal: AbortSignal = new AbortController().signal,
): Promise<AdvanceTurnResult> {
  const actions: StateMachineAction[] = []
  let cur = ctx

  // 存档级日志上下文（saveId/turn），便于排查特定存档/回合
  const saveId = cur.game.world.saveId
  const turn0 = cur.game.world.turnIndex
  logger.info('orch/turn/start', `开始推进回合（turn=${turn0}）`, {
    scope: 'save',
    saveId,
    turn: turn0,
    phaseStart: cur.game.phase,
  })

  // 若在 idle，先 START_TURN 进入 planning（空转演示友好）
  if (cur.game.phase === 'idle') {
    cur = step(cur, { type: 'START_TURN' }, signal)
    actions.push({ type: 'START_TURN' })
  }

  // planning → handshake（M2 命令握手由 handshake-flow 完成；若已进入 handshake/locked 则跳过）
  if (cur.game.phase === 'planning') {
    cur = step(cur, { type: 'ENTER_HANDSHAKE' }, signal)
    actions.push({ type: 'ENTER_HANDSHAKE' })
  }

  // handshake → locked（M2 玩家经 handshake-flow.lockOrders 锁定后已是 locked，跳过）
  if (cur.game.phase === 'handshake') {
    cur = step(cur, { type: 'CONFIRM_HANDSHAKE' }, signal)
    actions.push({ type: 'CONFIRM_HANDSHAKE' })
  }

  // locked → resolution（从 locked 起：玩家已握手锁定，或从 planning 空转至此）
  cur = step(cur, { type: 'ENTER_RESOLUTION' }, signal)
  actions.push({ type: 'ENTER_RESOLUTION' })
  logger.info('orch/turn/phase', 'phase → resolution（结算）', {
    scope: 'save',
    saveId,
    turn: turn0,
  })

  // resolution：调用结算服务（M1 空回合，产出空 ResolutionResult + 空 events）
  const resolve = services.resolve ?? defaultEmptyResolution
  const {
    resolution,
    events,
    world: resolvedWorld,
    contextSummary,
    pendingDecision,
  } = await resolve(cur, signal)

  // resolution → briefing
  // - 可选注入 resolver 产出的 world（已含 detection/reconHits 增量，让 UI 实时看到 level 提升）。
  // - M4-D：可选注入上下文压缩产物，更新 worldState.contextSummaries。
  const finishAction: StateMachineAction =
    resolvedWorld !== undefined && contextSummary !== undefined
      ? { type: 'FINISH_RESOLUTION', resolution, world: resolvedWorld, contextSummary }
      : resolvedWorld !== undefined
        ? { type: 'FINISH_RESOLUTION', resolution, world: resolvedWorld }
        : contextSummary
          ? { type: 'FINISH_RESOLUTION', resolution, contextSummary }
          : { type: 'FINISH_RESOLUTION', resolution }
  cur = step(cur, finishAction, signal)
  actions.push(finishAction)
  logger.info('orch/turn/resolved', `结算完成（events=${events.length}）`, {
    scope: 'save',
    saveId,
    turn: turn0,
    eventsCount: events.length,
    degraded: resolution.degraded,
  })

  // 第 6 批：FINISH_RESOLUTION 后调 evaluateVictory 判定胜负 + 折叠累计统计。
  // evaluateVictory 是纯函数（读 cur.game.world + cur.lastResolution → 新 world，
  // 含 victoryState/累计统计）。通过 SET_WORLD 写入 context（不改 phase，保持 briefing）。
  // 已终局时幂等（返回原 world）。胜负判定不伪造——基于真实 world 数据 + 剧本 victory 条件。
  const victoryWorld = evaluateVictory(cur.game.world)
  if (victoryWorld !== cur.game.world) {
    cur = step(cur, { type: 'SET_WORLD', world: victoryWorld }, signal)
    actions.push({ type: 'SET_WORLD', world: victoryWorld })
    if (victoryWorld.victoryState && victoryWorld.victoryState !== 'ongoing') {
      logger.info('orch/turn/victory', `战役终局：${victoryWorld.victoryState}`, {
        scope: 'save',
        saveId,
        turn: turn0,
        victoryState: victoryWorld.victoryState,
        winnerFactionId: victoryWorld.winnerFactionId ?? null,
        reason: victoryWorld.victoryReason ?? null,
      })
    }
  }

  // 第 3 批：战术决策挂起判定。
  // 导演部产出 pendingDecision 时，本回合在 briefing 后插入 decision 阶段：
  // OFFER_DECISION 挂起（不进 persist），等玩家在 DecisionPanel 选择 RESOLVE_DECISION，
  // 再由 resumeTurnAfterDecision 完成本回合（persist → idle → NEXT_TURN）。
  if (pendingDecision) {
    cur = step(cur, { type: 'OFFER_DECISION', decision: pendingDecision }, signal)
    actions.push({ type: 'OFFER_DECISION', decision: pendingDecision })
    logger.info('orch/turn/decision_pause', `战术决策挂起（turn=${turn0}）`, {
      scope: 'save',
      saveId,
      turn: turn0,
      decisionId: pendingDecision.id,
      decisionLabel: pendingDecision.label,
    })
    // 返回挂起句柄：携带本回合未落盘 events，供 resumeTurnAfterDecision 消费。
    const decisionHandle: DecisionResumeHandle = {
      events,
      turn: turn0,
      scenarioSeed: cur.game.world.scenarioSeed,
    }
    return { context: cur, actions, pausedAtDecision: true, decisionHandle }
  }

  // 无决策：briefing → persist → idle → NEXT_TURN（原闭环）
  const persistResult = await runPersistPhase(cur, services, events, turn0, signal)
  return { context: persistResult.context, actions: [...actions, ...persistResult.actions] }
}

/**
 * 第 3 批：决策挂起后恢复——玩家 RESOLVE_DECISION 后完成本回合。
 *
 * 流程（decision → persist → idle → NEXT_TURN）：
 * 1. ctx 应处于 decision 阶段且 pendingDecision 已由 RESOLVE_DECISION 清空
 *    （world 已应用所选选项的 overrides）。
 * 2. 调用方（store）先 dispatch RESOLVE_DECISION（纯函数 reducer，应用 overrides 到 world），
 *    再把更新后的 ctx + advanceTurn 返回的 decisionHandle 传入本方法。
 * 3. 本方法把决策后果 overrides 转 source:'director' 事件并入 events（落 event-log，回放采信），
 *    再走 persist → idle → NEXT_TURN（与无决策路径完全一致）。
 *
 * 决策后果留痕：所选选项的 overrides 落 event-log（source:'director'，回放采信，不重算）。
 * 跳过（optionId=null）时无后果事件，events 仅含原 physics/director/random_events。
 *
 * @param ctx 玩家 RESOLVE_DECISION 后的上下文（phase 应为 persist，world 已应用 overrides）
 * @param services 副作用服务句柄
 * @param handle advanceTurn 暂停时返回的 DecisionResumeHandle（携带未落盘 events + turn）
 * @param optionId 玩家选择的选项 id（null=跳过）；用于日志上下文
 * @param overrides 玩家选择的选项的 overrides（来自 DecisionPanel，与 RESOLVE_DECISION 同源）
 * @param signal AbortSignal
 */
export async function resumeTurnAfterDecision(
  ctx: StateMachineContext,
  services: TurnOrchestratorServices,
  handle: DecisionResumeHandle,
  optionId: string | null,
  overrides: import('@/layers/agents/protocol/schema').DirectorOverride[],
  signal: AbortSignal = new AbortController().signal,
): Promise<AdvanceTurnResult> {
  const actions: StateMachineAction[] = []
  const cur = ctx
  const saveId = cur.game.world.saveId

  // 决策后果 overrides 转 source:'director' 事件并入 events（落 event-log，回放采信）。
  // 跳过（optionId=null）时 overrides 为空，无后果事件。
  const decisionEvents = decisionOverridesToEvents(
    overrides,
    handle.scenarioSeed,
    handle.turn,
    optionId,
  )
  const allEvents: AgentAction[] = [...handle.events, ...decisionEvents]

  logger.info('orch/turn/decision_resume', `战术决策已解决（optionId=${optionId ?? 'skip'}）`, {
    scope: 'save',
    saveId,
    turn: handle.turn,
    optionId,
    overridesCount: overrides.length,
  })

  // 走 persist → idle → NEXT_TURN（与无决策路径一致）
  const result = await runPersistPhase(cur, services, allEvents, handle.turn, signal)
  return { context: result.context, actions: [...actions, ...result.actions] }
}

/**
 * 持久化阶段闭环（briefing/persist → persist → idle → NEXT_TURN）。
 *
 * advanceTurn（无决策）与 resumeTurnAfterDecision（决策后）共用此方法：
 * 1. ENTER_PERSIST（briefing → persist）。
 * 2. await writeTurn 落盘（含 events；落盘 turnIndex+1，刷新显示正确回合）。
 * 3. PERSIST_COMPLETE → NEXT_TURN。
 *
 * 落盘失败回路：persist → briefing，抛 TURN_PERSIST_FAILED。
 *
 * @param ctx 进入 persist 前的上下文（phase 应为 briefing 或 persist-after-decision）
 * @param services 副作用服务句柄
 * @param events 本回合全部事件（含决策后果 overrides 事件，落 event-log）
 * @param turn0 本回合号（日志上下文）
 * @param signal AbortSignal
 */
async function runPersistPhase(
  ctx: StateMachineContext,
  services: TurnOrchestratorServices,
  events: AgentAction[],
  turn0: number,
  signal: AbortSignal,
): Promise<AdvanceTurnResult> {
  const actions: StateMachineAction[] = []
  let cur = ctx
  const saveId = cur.game.world.saveId

  // briefing → persist（或 decision 后的 persist-after-resolve 已由 reducer 完成 phase 迁移，
  // 但 resumeTurnAfterDecision 路径下 ctx.phase 可能已是 persist——此处守卫：
  // 若已是 persist 则跳过 ENTER_PERSIST，避免重复迁移）。
  if (cur.game.phase === 'briefing') {
    cur = step(cur, { type: 'ENTER_PERSIST' }, signal)
    actions.push({ type: 'ENTER_PERSIST' })
  }

  // persist：**await** 落盘（非 fire-and-forget，关键防坑）
  //
  // 落盘语义（关键）：world-state.json / manifest 落盘的是**下一回合 idle 态**
  // （turnIndex+1），而非当前结算回合 N。原因：刷新（loadSave）从 world-state 恢复，
  // 若落盘 turnIndex=N（结算完未+1），刷新后 UI 显示回合 N，比实际少 1，体感像丢档。
  // 落盘 N+1 后，刷新显示正确回合。
  //
  // 回放不受影响（验收#7 红线）：
  // - event-log 记录的是回合 N 的事件（action.turn=N），哈希比对/物理重算均基于
  //   event-log，与 world-state.json 的 turnIndex 无关；
  // - restoreFromEventLog 是纯函数，baseWorld.turnIndex 仅作起点，最终 turnIndex
  //   由 `maxTurn+1`（event-log 最大回合+1）覆盖（见 replay.ts:110-113）；
  // - 物理重算 seed = scenarioSeed:turn:sequence，turn 取自 event.turn，非 world.turnIndex。
  // 故 world-state 落盘 N+1 不破坏回放确定性/哈希回归。
  //
  // persist-gate 不受影响：reducer 顺序仍是 persist→PERSIST_COMPLETE→NEXT_TURN，
  // 落盘的 turnIndex 数值与 persist-gate（persistCompleted 守卫）正交。
  const phaseBeforePersist: GamePhase = 'persist'
  try {
    const world: WorldState = cur.game.world
    // 构造下一回合 idle 态落盘：仅 turnIndex+1，其余世界数据沿用结算结果。
    // （此处不调 reducer NEXT_TURN——那会污染内存上下文；只构造落盘用的快照。）
    const persistedWorld: WorldState = {
      ...world,
      turnIndex: world.turnIndex + 1,
    }
    await services.persistence.writeTurn(persistedWorld, phaseBeforePersist, events)
    logger.info('orch/turn/persist', `落盘成功（turn ${turn0}→${turn0 + 1}）`, {
      scope: 'save',
      saveId,
      turn: turn0,
      eventsCount: events.length,
    })
  } catch (err) {
    // 落盘失败回路：persist → briefing，等待重试；抛错供 UI 提示
    // P2-2：落一条诊断（category=persist，level=error，仅概要 message，绝不写 key/payload）
    //   诊断用 fire-and-forget：失败不得掩盖原始落盘错误，故不等 await。
    void appendDiagnostic(cur.game.world.saveId, {
      level: 'error',
      category: 'persist',
      message: `writeTurn 失败: ${String(err)}`,
    })
    logger.error('orch/turn/persist_failed', `落盘失败: ${String(err)}`, {
      scope: 'save',
      saveId,
      turn: turn0,
    })
    cur = step(cur, { type: 'PERSIST_FAILED', reason: String(err) }, signal)
    actions.push({ type: 'PERSIST_FAILED', reason: String(err) })
    throw Object.assign(new Error(`turn-orchestrator: 落盘失败 ${String(err)}`), {
      code: TURN_PERSIST_FAILED,
      context: cur,
    })
  }

  // 落盘成功 → PERSIST_COMPLETE（置 persistCompleted=true，放行 NEXT_TURN）
  cur = step(cur, { type: 'PERSIST_COMPLETE' }, signal)
  actions.push({ type: 'PERSIST_COMPLETE' })

  // idle → NEXT_TURN（turnIndex+1；persist-gate 守卫已过）
  cur = step(cur, { type: 'NEXT_TURN' }, signal)
  actions.push({ type: 'NEXT_TURN' })
  logger.info('orch/turn/done', `回合推进完成（turn ${turn0}→${turn0 + 1}）`, {
    scope: 'save',
    saveId,
    turn: turn0 + 1,
  })

  return { context: cur, actions }
}

/**
 * 第 3 批：把玩家选择的决策后果 overrides 转 source:'director' AgentAction（落 event-log）。
 *
 * 与 director.overridesToDirectorActions 同构，但 sequence 用决策专用槽位 4010+，
 * 与 director 自身覆写（3000+）和随机事件（4001+）区分，保证同回合互斥 event id。
 *
 * 跳过（optionId=null）时返回空数组（无后果事件）。
 */
function decisionOverridesToEvents(
  overrides: readonly import('@/layers/agents/protocol/schema').DirectorOverride[],
  scenarioSeed: string,
  turn: number,
  optionId: string | null,
): AgentAction[] {
  if (overrides.length === 0) return []
  return overrides.map((ov, i) => {
    const sequence = SEQUENCE_DIRECTOR_DECISION_OVERRIDE_BASE + i
    return {
      id: `evt:${turn}:${sequence}:decision-override:${optionId ?? 'skip'}:${i}`,
      turn,
      agentId: 'director-decision',
      agentRole: 'director',
      kind: 'adjudication',
      source: 'director' as const,
      payload: {
        kind: 'override',
        field: ov.field,
        before: ov.before,
        after: ov.after,
        reason: ov.reason,
        // 标记此 override 来自战术决策（区别于导演部终裁覆写）
        decisionOptionId: optionId,
      },
      text: `[战术决策] ${ov.field}: ${JSON.stringify(ov.before)} → ${JSON.stringify(ov.after)}（${ov.reason}）`,
      sequence,
      seed: `${scenarioSeed}:${turn}:${sequence}`,
    }
  })
}

/**
 * M1 默认空结算：产出空 ResolutionResult + 空 events。
 *
 * M2+ 由 services.resolve 注入真实物理/Agent 结算。
 */
async function defaultEmptyResolution(
  ctx: StateMachineContext,
  _signal: AbortSignal,
): Promise<{
  resolution: ResolutionSummary
  events: AgentAction[]
  world?: WorldState
  contextSummary?: { turn: number; text: string }
  pendingDecision?: TacticalDecision
}> {
  const resolution: ResolutionSummary = {
    turn: ctx.game.world.turnIndex,
    casualties: {},
    objectiveChanges: [],
    reportText: '',
    degraded: false,
  }
  return { resolution, events: [] }
}

// ============================================================================
// M2 默认结算器：物理引擎 Worker + 导演部 mock 终裁
// ============================================================================

/**
 * 构造 M2 默认结算器：接物理引擎 Worker + 导演部 mock 终裁。
 *
 * 流程（locked → resolution 阶段调用）：
 * 1. 收集所有阵营的 lockedOrders 扁平化为数组（按 sequence 升序）。
 * 2. 调 workerService.simulateTurn(world, lockedOrders, scenarioSeed)
 *    得物理结果（source:'physics'）。
 * 3. 调 director.adjudicate（mock：直接采信物理结果 + 拼装战报）。
 * 4. 返回 { resolution: ResolutionSummary, events: AgentAction[] }，
 *    其中 events 标 source:'physics'（落盘 event-log）。
 *
 * 返回的函数符合 TurnOrchestratorServices.resolve 签名，可直接注入。
 *
 * @param workerService 物理引擎客户端（需已 init）
 * @param director 导演部角色（M2 mock）
 * @returns resolve 服务函数
 */
export function createDefaultResolver(
  workerService: PhysicsEngineClient,
  director: DirectorRole,
  /**
   * M4-D 上下文压缩器（可选，每 5 回合触发）。
   * 注入后，当 shouldCompressContext(turn) 时产出压缩产物（事件 + 新 contextSummaries）。
   * 落盘（写 factions/{factionId}/context-summary.md）经 writeFactionFile 完成。
   */
  compressionDeps?: {
    compressor: ContextCompressor
    writeFactionFile: (factionId: string, content: string) => Promise<void>
  },
  /**
   * 第 3 批：战役战术决策模板（可选，来自 CampaignRules.decisions）。
   * 注入后，导演部 adjudicate 内按 triggerCondition 判定是否触发本回合决策。
   */
  decisionTemplates?: TacticalDecisionTemplate[],
): NonNullable<TurnOrchestratorServices['resolve']> {
  return async (ctx, _signal) => {
    const world = ctx.game.world
    const turn = world.turnIndex

    // 1. 扁平化 lockedOrders（按 sequence 升序，保证确定性）
    const lockedOrders = Object.values(ctx.lockedOrders)
      .flat()
      .sort((a, b) => a.sequence - b.sequence)

    // 2. 物理引擎结算（Worker）
    const physicsResult: ResolutionResult = await workerService.simulateTurn(
      world,
      lockedOrders,
      world.scenarioSeed,
    )

    // 3. 导演部终裁（mock：透传物理结果 + 战报拼装）
    const directorResult = await director.adjudicate({
      physicsResult,
      envelopes: lockedOrders,
      world,
      scenarioSeed: world.scenarioSeed,
      turn,
      // 第 3 批：决策模板（导演部按 triggerCondition 判定是否触发）
      decisionTemplates,
    })

    const events: AgentAction[] = [...directorResult.directorEvents]
    let contextSummary: { turn: number; text: string } | undefined

    // 4. M4-D 上下文压缩（每 5 回合，TDD §3.6）
    if (compressionDeps && shouldCompressContext(turn)) {
      const { summary, event } = await compressionDeps.compressor.compress(
        world,
        world.scenarioSeed,
        turn,
      )
      // 落盘 context-summary.md 到每个阵营目录（经 gateway fs_write_faction_file）
      for (const f of world.factions) {
        await compressionDeps.writeFactionFile(f.id, summary)
      }
      events.push(event)
      contextSummary = { turn, text: summary }
    }

    // 5. 返回战报摘要 + 事件（落盘 event-log，source:'physics'）+ 可选压缩产物
    //    Bug1/2/4 核心修复：应用**完整**结算增量（coord/strength/morale/detection/歼灭/reconHits）
    //    到内存 world。原仅 applyResolutionToIntel（仅 detection），导致单位坐标永不回写
    //    （Bug1）、hold 数值不生效（Bug2）。现在用 applyResolutionStateChanges 完整 apply，
    //    与回放路径 replay.commitStateChanges 语义对齐（实时态=回放态）。
    const worldResolved = applyResolutionStateChanges(
      world,
      directorResult.finalResult.stateChanges,
      turn,
    )
    return {
      resolution: directorResult.resolutionSummary,
      events,
      world: worldResolved,
      contextSummary,
      // 第 3 批：战术决策（导演部按模板产出，undefined=无决策）
      pendingDecision: directorResult.pendingDecision,
    }
  }
}

// ============================================================================
// M3 多 Agent 结算器：接 orchestrateTurnResolution（替换 M2 mock director）
// ============================================================================

import type { LlmService } from '@/layers/application/services/llm-service'
import type { TheaterRole, CommanderRole, LlmCallConfig } from '@/layers/agents/roles'
import { orchestrateTurnResolution } from '@/layers/agents/orchestrator/turn-resolution'
import type { TurnResolutionProgress } from '@/layers/agents/orchestrator/turn-resolution'

/**
 * M3 多 Agent 结算器所需的角色与服务（依赖注入，便于 mock 测试）。
 */
export interface MultiAgentResolverDeps {
  /** LLM 服务（真流式 + schema 校验 + 缓存统计） */
  llmService: LlmService
  /** 物理引擎客户端（需已 init） */
  workerService: PhysicsEngineClient
  /** 战区司令角色（mock 或 LLM） */
  theaterRole: TheaterRole
  /** 敌/盟统帅角色（mock 或 LLM） */
  commanderRole: CommanderRole
  /** 导演部角色（mock 或 LLM） */
  directorRole: DirectorRole
  /**
   * 玩家阵营 id（可选）。
   * 视角 bug 修复：不传时由 orchestrateTurnResolution 内部从 world.playerFactionId
   * （v0.2.2+ 权威）取，fallback side==='player'。多数调用方无需显式传入。
   */
  playerFactionId?: string
  /** LLM 调用配置（mock 角色可省略；LLM 角色需注入） */
  llmConfig?: LlmCallConfig
  /**
   * 进度回调（可选）：透传给 orchestrateTurnResolution，更新 UI 进度条。
   * 纯可观测副作用，不影响编排产物与确定性。
   */
  onProgress?: (entry: TurnResolutionProgress) => void
  /** 流式战报增量回调（可选）：透传给导演部 streamTextWithDeltas。 */
  onReportChunk?: (chunk: string) => void
  /**
   * Agent 实时 partial 回调（第 2 批，可选）：透传给 orchestrateTurnResolution，
   * theater/commander resolve 流式产出时以 (agentId, partial) 回调。
   * store 据此 setAgentLiveOutput → AgentInspector 显示实时输出。
   * 纯可观测副作用，不影响编排产物与确定性。
   */
  onAgentDelta?: (agentId: string, partial: string) => void
  /**
   * M4-D 上下文压缩（可选，每 5 回合 TDD §3.6）。
   * 注入后，当 shouldCompressContext(turn) 时产出压缩产物。
   * 落盘（写 factions/{factionId}/context-summary.md）经 writeFactionFile 完成。
   */
  compressionDeps?: {
    compressor: ContextCompressor
    writeFactionFile: (factionId: string, content: string) => Promise<void>
  }
  /**
   * 第 2 批：战役规则（可选，含 randomEvents 模板）。
   * 注入后编排器在物理结算后、导演部 adjudicate 前 rollRandomEvents。
   * 不注入时本回合无随机事件（与既有行为兼容）。
   *
   * 若同时提供 getCampaignRules，则优先用 getCampaignRules（按 scenarioId 动态查表）；
   * 否则用静态 campaignRules。
   */
  campaignRules?: CampaignRules
  /**
   * 第 2 批：按 scenarioId 动态查询战役规则（优先于静态 campaignRules）。
   *
   * 用于 store 持有多个战役包时按当前 world.scenarioId 取对应 rules。
   * 返回 undefined 时回退到 campaignRules 字段（再 undefined 则无随机事件）。
   */
  getCampaignRules?: (scenarioId: string) => CampaignRules | undefined
}

/**
 * 构造 M3 多 Agent 结算器：接 orchestrateTurnResolution。
 *
 * 流程（locked → resolution 阶段调用）：
 * 1. 把 ctx.lockedOrders（按 factionId 分组）传入编排器。
 * 2. 编排器内部：物理先算 → chief 收集 → theater/commander 并行 → director 终裁。
 * 3. 导演部 LLM 失败 → 编排器自动切规则引擎兜底（绝不卡死游戏）。
 * 4. 返回战报摘要 + 事件（落盘 event-log）：
 *    - physics 事件标 source:'physics'（可重算校验）；
 *    - director 覆写/战报标 source:'director'（记录即真相）；
 *    - 规则引擎兜底标 source:'rule-engine'（回放采信）。
 *
 * @param deps 多 Agent 依赖
 * @returns resolve 服务函数（符合 TurnOrchestratorServices.resolve 签名）
 */
export function createMultiAgentResolver(
  deps: MultiAgentResolverDeps,
): NonNullable<TurnOrchestratorServices['resolve']> {
  return async (ctx, _signal) => {
    const world = ctx.game.world

    const result = await orchestrateTurnResolution({
      worldState: world,
      lockedOrders: ctx.lockedOrders,
      scenarioSeed: world.scenarioSeed,
      turn: world.turnIndex,
      llmService: deps.llmService,
      workerService: deps.workerService,
      theaterRole: deps.theaterRole,
      commanderRole: deps.commanderRole,
      directorRole: deps.directorRole,
      playerFactionId: deps.playerFactionId,
      llmConfig: deps.llmConfig,
      onProgress: deps.onProgress,
      onReportChunk: deps.onReportChunk,
      onAgentDelta: deps.onAgentDelta,
      // 第 2 批：按 scenarioId 动态查 rules（优先），否则用静态 campaignRules
      campaignRules:
        deps.getCampaignRules?.(world.scenarioId) ?? deps.campaignRules,
    })

    // 把编排器的 degraded 标志反映到 resolution.degraded（UI 据此明示降级结算）。
    const resolution: ResolutionSummary = result.degraded
      ? { ...result.resolution, degraded: true }
      : result.resolution

    // 事件直接采用编排器产出（已按 source 分源标记）。
    const events: AgentAction[] = [...result.events]
    let contextSummary: { turn: number; text: string } | undefined

    // 第 2 批：采用编排器返回的 world（含随机事件注入的援军单位）。
    // 无随机事件时 result.world === 入参 world（无开销）。
    const worldWithRandomEvents = result.world

    // M4-D 上下文压缩（每 5 回合，TDD §3.6）
    if (deps.compressionDeps && shouldCompressContext(world.turnIndex)) {
      const { summary, event } = await deps.compressionDeps.compressor.compress(
        worldWithRandomEvents,
        world.scenarioSeed,
        world.turnIndex,
      )
      for (const f of worldWithRandomEvents.factions) {
        await deps.compressionDeps.writeFactionFile(f.id, summary)
      }
      events.push(event)
      contextSummary = { turn: world.turnIndex, text: summary }
    }

    // Bug1/2/4 核心修复：应用**完整**结算增量到内存 world（见上方 M2 路径同名注释）。
    const worldResolved = applyResolutionStateChanges(
      worldWithRandomEvents,
      result.result.stateChanges,
      world.turnIndex,
    )

    return {
      resolution,
      events,
      world: worldResolved,
      contextSummary,
      // 第 3 批：战术决策（编排器按 rules.decisions 模板产出，undefined=无决策）
      pendingDecision: result.pendingDecision,
    }
  }
}

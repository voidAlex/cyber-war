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
} from '@/types'
import type {
  StateMachineContext,
  StateMachineAction,
} from '@/layers/application/state-machine/types'
import { wegoReducer } from '@/layers/application/state-machine/reducer'
import type { PersistenceService } from '@/layers/application/services/persistence-service'
import type { PhysicsEngineClient } from '@/layers/application/services/worker-service'
import type { ResolutionResult } from '@/layers/domain/combat'
import type { DirectorRole, ContextCompressor } from '@/layers/agents/roles/director'
import { shouldCompressContext } from '@/layers/agents/roles/context-compression'
import { appendDiagnostic } from '@/layers/persistence/diagnostics'

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
     * M4-D 上下文压缩产物（可选，每 5 回合）。
     * 仅当 shouldCompressContext(turn) 时由 resolver 注入：
     * 含 { turn, text }，编排器据此在 FINISH_RESOLUTION 更新 worldState.contextSummaries。
     * 压缩事件已包含在 events 中（source:'rule-engine'，回放采信）。
     */
    contextSummary?: { turn: number; text: string }
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

  // resolution：调用结算服务（M1 空回合，产出空 ResolutionResult + 空 events）
  const resolve = services.resolve ?? defaultEmptyResolution
  const { resolution, events, contextSummary } = await resolve(cur, signal)

  // resolution → briefing（M4-D：可选注入上下文压缩产物，更新 worldState.contextSummaries）
  const finishAction: StateMachineAction = contextSummary
    ? { type: 'FINISH_RESOLUTION', resolution, contextSummary }
    : { type: 'FINISH_RESOLUTION', resolution }
  cur = step(cur, finishAction, signal)
  actions.push(finishAction)

  // briefing → persist
  cur = step(cur, { type: 'ENTER_PERSIST' }, signal)
  actions.push({ type: 'ENTER_PERSIST' })

  // persist：**await** 落盘（非 fire-and-forget，关键防坑）
  const phaseBeforePersist: GamePhase = 'persist'
  try {
    const world: WorldState = cur.game.world
    await services.persistence.writeTurn(world, phaseBeforePersist, events)
  } catch (err) {
    // 落盘失败回路：persist → briefing，等待重试；抛错供 UI 提示
    // P2-2：落一条诊断（category=persist，level=error，仅概要 message，绝不写 key/payload）
    //   诊断用 fire-and-forget：失败不得掩盖原始落盘错误，故不等 await。
    void appendDiagnostic(cur.game.world.saveId, {
      level: 'error',
      category: 'persist',
      message: `writeTurn 失败: ${String(err)}`,
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

  return { context: cur, actions }
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
  contextSummary?: { turn: number; text: string }
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
    return {
      resolution: directorResult.resolutionSummary,
      events,
      contextSummary,
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
  /** 玩家阵营 id（可选，默认取 side==='player'） */
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
   * M4-D 上下文压缩（可选，每 5 回合 TDD §3.6）。
   * 注入后，当 shouldCompressContext(turn) 时产出压缩产物。
   * 落盘（写 factions/{factionId}/context-summary.md）经 writeFactionFile 完成。
   */
  compressionDeps?: {
    compressor: ContextCompressor
    writeFactionFile: (factionId: string, content: string) => Promise<void>
  }
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
    })

    // 把编排器的 degraded 标志反映到 resolution.degraded（UI 据此明示降级结算）。
    const resolution: ResolutionSummary = result.degraded
      ? { ...result.resolution, degraded: true }
      : result.resolution

    // 事件直接采用编排器产出（已按 source 分源标记）。
    const events: AgentAction[] = [...result.events]
    let contextSummary: { turn: number; text: string } | undefined

    // M4-D 上下文压缩（每 5 回合，TDD §3.6）
    if (deps.compressionDeps && shouldCompressContext(world.turnIndex)) {
      const { summary, event } = await deps.compressionDeps.compressor.compress(
        world,
        world.scenarioSeed,
        world.turnIndex,
      )
      for (const f of world.factions) {
        await deps.compressionDeps.writeFactionFile(f.id, summary)
      }
      events.push(event)
      contextSummary = { turn: world.turnIndex, text: summary }
    }

    return {
      resolution,
      events,
      contextSummary,
    }
  }
}

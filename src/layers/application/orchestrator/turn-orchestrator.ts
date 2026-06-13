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

/**
 * 编排器所需的副作用服务句柄（依赖注入，便于 mock 测试）。
 */
export interface TurnOrchestratorServices {
  /** 持久化服务（world-state 原子写 + event-log 追加） */
  persistence: PersistenceService
  /**
   * 结算服务（M1 空回合产出空 ResolutionResult；M2+ 接入物理/Agent）。
   * 返回 { resolution, events }。M1 events 为空数组。
   */
  resolve?: (ctx: StateMachineContext, signal: AbortSignal) => Promise<{
    resolution: ResolutionSummary
    events: AgentAction[]
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

  // planning → handshake
  cur = step(cur, { type: 'ENTER_HANDSHAKE' }, signal)
  actions.push({ type: 'ENTER_HANDSHAKE' })

  // handshake → locked（空回合无命令，直接锁定）
  cur = step(cur, { type: 'CONFIRM_HANDSHAKE' }, signal)
  actions.push({ type: 'CONFIRM_HANDSHAKE' })

  // locked → resolution
  cur = step(cur, { type: 'ENTER_RESOLUTION' }, signal)
  actions.push({ type: 'ENTER_RESOLUTION' })

  // resolution：调用结算服务（M1 空回合，产出空 ResolutionResult + 空 events）
  const resolve = services.resolve ?? defaultEmptyResolution
  const { resolution, events } = await resolve(cur, signal)

  // resolution → briefing
  cur = step(cur, { type: 'FINISH_RESOLUTION', resolution }, signal)
  actions.push({ type: 'FINISH_RESOLUTION', resolution })

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
): Promise<{ resolution: ResolutionSummary; events: AgentAction[] }> {
  const resolution: ResolutionSummary = {
    turn: ctx.game.world.turnIndex,
    casualties: {},
    objectiveChanges: [],
    reportText: '',
    degraded: false,
  }
  return { resolution, events: [] }
}

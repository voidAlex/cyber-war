/**
 * 命令握手流程编排（handshake-flow.ts）— 显式 service 函数。
 *
 * 对应重写计划「状态机实现方案」「握手协议」与 TDD §3.2：
 *   planning（玩家输入命令触发握手）→ handshake（参谋反问+预演虚线+玩家确认）
 *   → pendingOrders 累积 → 玩家「锁定」→ locked。
 *
 * 职责：把命令握手的状态机推进 + 命令入队/确认/锁定封装为可复用 helper，
 * 经 reducer + guard，不绕过状态机。UI（CommandTerminal）通过 store 调用这些 helper。
 *
 * 与 turn-orchestrator 的分工：
 * - handshake-flow：planning → handshake → locked（命令握手阶段，玩家交互）。
 * - turn-orchestrator：locked → resolution → briefing → persist → idle（结算阶段）。
 *
 * 阶段守卫严格（guard.canSubmitOrder/canConfirmHandshake/canLockOrders），
 * UI + reducer 双保险。
 *
 * @module layers/application/orchestrator/handshake-flow
 */

import type { ActionEnvelope } from '@/types'
import type { StateMachineContext, StateMachineAction } from '@/layers/application/state-machine/types'
import { wegoReducer } from '@/layers/application/state-machine/reducer'
import {
  canSubmitOrder,
  canConfirmHandshake,
  canLockOrders,
} from '@/layers/application/state-machine/guard'

/** handshake-flow 操作失败时的错误（守卫拒绝）。 */
export class HandshakeError extends Error {
  constructor(
    message: string,
    /** 守卫拒绝时涉及的 action 类型 */
    readonly actionType: string,
    /** 守卫拒绝时的上下文快照（供 UI 恢复展示） */
    readonly context: StateMachineContext,
  ) {
    super(message)
    this.name = 'HandshakeError'
  }
}

/**
 * 内部：dispatch 一个 action 到 reducer；守卫失败时抛 HandshakeError。
 */
function dispatch(
  ctx: StateMachineContext,
  action: StateMachineAction,
): StateMachineContext {
  const result = wegoReducer(ctx, action)
  if (!result.ok) {
    throw new HandshakeError(
      `handshake-flow: 守卫拒绝 ${action.type}：${result.error}`,
      action.type,
      ctx,
    )
  }
  return result.state
}

/**
 * 开始握手：planning → handshake。
 *
 * 玩家在 planning 输入命令时，UI 先调此函数进入握手阶段（参谋反问/预演）。
 * 守卫：仅 planning 阶段允许。
 *
 * @param ctx 当前上下文
 * @returns 进入 handshake 后的新上下文
 * @throws HandshakeError 当非 planning 阶段
 */
export function enterHandshake(ctx: StateMachineContext): StateMachineContext {
  if (ctx.game.phase !== 'planning') {
    throw new HandshakeError(
      `当前阶段为 ${ctx.game.phase}，无法进入握手`,
      'ENTER_HANDSHAKE',
      ctx,
    )
  }
  return dispatch(ctx, { type: 'ENTER_HANDSHAKE' })
}

/**
 * 提交一条命令到 pendingOrders（玩家确认候选命令后入队）。
 *
 * 守卫：仅 planning/handshake 阶段允许（guard.canSubmitOrder）。
 * 入队后沙盘 Sandbox 自动显示虚线预演（订阅 pendingOrders）。
 *
 * @param ctx 当前上下文
 * @param envelope 待入队的命令信封（由 ParsedCommand 构造，见 buildEnvelope）
 * @returns 入队后的新上下文
 * @throws HandshakeError 当阶段守卫不满足
 */
export function submitOrder(
  ctx: StateMachineContext,
  envelope: ActionEnvelope,
): StateMachineContext {
  if (!canSubmitOrder(ctx.game.phase)) {
    throw new HandshakeError(
      `当前阶段为 ${ctx.game.phase}，无法提交命令`,
      'SUBMIT_ORDER',
      ctx,
    )
  }
  return dispatch(ctx, { type: 'SUBMIT_ORDER', envelope })
}

/**
 * 锁定所有 pendingOrders 进入结算（handshake → locked）。
 *
 * 玩家「锁定」按钮调用。守卫：仅 handshake 阶段允许（guard.canLockOrders）。
 * reducer 内 CONFIRM_HANDSHAKE 把 pendingOrders 清入 lockedOrders（按 faction 分组）。
 *
 * @param ctx 当前上下文
 * @returns 进入 locked 后的新上下文（pendingOrders 已并入 lockedOrders）
 * @throws HandshakeError 当非 handshake 阶段
 */
export function lockOrders(ctx: StateMachineContext): StateMachineContext {
  if (!canLockOrders(ctx.game.phase)) {
    throw new HandshakeError(
      `当前阶段为 ${ctx.game.phase}，无法锁定命令`,
      'LOCK_ORDERS',
      ctx,
    )
  }
  return dispatch(ctx, { type: 'CONFIRM_HANDSHAKE' })
}

/**
 * 是否可以进入握手（planning 阶段）。
 * UI 用此判断「输入命令」按钮是否可用。
 */
export function canEnterHandshake(ctx: StateMachineContext): boolean {
  return ctx.game.phase === 'planning'
}

/**
 * 是否可以提交命令（planning/handshake 阶段）。
 * UI 输入框禁用双保险。
 */
export function canSubmitNow(ctx: StateMachineContext): boolean {
  return canSubmitOrder(ctx.game.phase)
}

/**
 * 是否可以锁定命令（handshake 阶段且有 pendingOrders）。
 * UI「锁定」按钮禁用判断。
 */
export function canLockNow(ctx: StateMachineContext): boolean {
  return canConfirmHandshake(ctx.game.phase) && ctx.pendingOrders.length > 0
}

/**
 * 从候选命令构造 ActionEnvelope（玩家确认入队前调用）。
 *
 * sequence 由 sequence-allocator 段位规则预分配（chief 段 0+）。
 * state='pending'（待锁定）。
 *
 * @param params 构造参数
 * @returns ActionEnvelope
 */
export function buildEnvelope(params: {
  turn: number
  faction: string
  intent: string
  payload: Record<string, unknown>
  sequence: number
  agentId?: string
}): ActionEnvelope {
  return {
    turn: params.turn,
    faction: params.faction,
    agentId: params.agentId ?? 'chief-player',
    agentRole: 'chief',
    intent: params.intent,
    payload: params.payload,
    confidence: 0.8,
    requiresConfirmation: true,
    sequence: params.sequence,
    state: 'pending',
  }
}

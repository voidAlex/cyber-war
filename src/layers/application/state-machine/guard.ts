/**
 * 状态机阶段守卫（guard.ts）— 纯函数。
 *
 * 对应重写计划关键防坑表：
 * - 「命令提交无视阶段」：canSubmitOrder 仅在 planning/handshake 允许。
 * - 「NEXT_TURN 无 phase 守卫」：canAdvanceTurn 受 persist-gate 守卫。
 * - reducer 对 SUBMIT_ORDER / LOCK_ORDERS / CONFIRM_HANDSHAKE / NEXT_TURN
 *   守卫不满足时返回 {...ctx, error}，绝不默默执行。
 *
 * 本文件全部为纯函数，不读外部状态、不发起副作用。
 *
 * @module layers/application/state-machine/guard
 */

import type { GamePhase } from '@/types'
import type { StateMachineContext, StateMachineAction } from './types'

/**
 * 是否允许在当前阶段提交命令（SUBMIT_ORDER）。
 * planning（玩家下指令）/ handshake（参谋反问后补充）允许。
 */
export function canSubmitOrder(phase: GamePhase): boolean {
  return phase === 'planning' || phase === 'handshake'
}

/**
 * 是否允许在当前阶段进入握手确认（CONFIRM_HANDSHAKE）。
 * 仅 handshake 阶段允许。
 */
export function canConfirmHandshake(phase: GamePhase): boolean {
  return phase === 'handshake'
}

/**
 * 是否允许锁定命令（LOCK_ORDERS）。
 * 仅 handshake 阶段允许（语义与 CONFIRM_HANDSHAKE 等价，UI 二选一）。
 */
export function canLockOrders(phase: GamePhase): boolean {
  return phase === 'handshake'
}

/**
 * 是否允许推进到下一回合（NEXT_TURN）。
 *
 * persist-gate 核心：persist 未完成时禁止进下一回合
 * （对应重写计划「persist 被 UI 跳过、10s 轮询丢档」）。
 * 同时要求当前处于 idle 阶段（PERSIST_COMPLETE 后回到 idle 才能推进）。
 */
export function canAdvanceTurn(ctx: StateMachineContext): boolean {
  return ctx.game.phase === 'idle' && ctx.persistCompleted
}

/**
 * 判断某动作在当前上下文下是否被守卫放行。
 *
 * 用于 reducer 分支前置校验与 UI 按钮禁用双保险。
 * 返回 null 表示放行；返回字符串表示拒绝原因（即 error message）。
 *
 * @param ctx 当前状态机上下文
 * @param action 待判定的动作
 * @returns null=放行；string=拒绝原因
 */
export function guardAction(
  ctx: StateMachineContext,
  action: StateMachineAction,
): string | null {
  const phase = ctx.game.phase

  switch (action.type) {
    case 'START_TURN':
      if (phase !== 'idle') return `当前阶段为 ${phase}，无法开始规划`
      return null

    case 'ENTER_HANDSHAKE':
      if (phase !== 'planning') return `当前阶段为 ${phase}，无法进入握手`
      return null

    case 'CONFIRM_HANDSHAKE':
    case 'LOCK_ORDERS':
      if (!canLockOrders(phase)) {
        return `当前阶段为 ${phase}，无法锁定命令`
      }
      return null

    case 'ENTER_RESOLUTION':
      if (phase !== 'locked') return `当前阶段为 ${phase}，无法进入结算`
      return null

    case 'FINISH_RESOLUTION':
      if (phase !== 'resolution') return `当前阶段为 ${phase}，无法完成结算`
      return null

    case 'ENTER_PERSIST':
      if (phase !== 'briefing') return `当前阶段为 ${phase}，无法进入持久化`
      return null

    case 'OFFER_DECISION':
      // 第 3 批：仅 briefing 阶段允许弹出战术决策
      if (phase !== 'briefing') return `当前阶段为 ${phase}，无法弹出战术决策`
      return null

    case 'RESOLVE_DECISION':
      // 第 3 批：仅 decision 阶段允许解决（玩家选择/跳过）
      if (phase !== 'decision') return `当前阶段为 ${phase}，无法解决战术决策`
      return null

    case 'PERSIST_COMPLETE':
      if (phase !== 'persist') return `当前阶段为 ${phase}，无法完成持久化`
      return null

    case 'NEXT_TURN':
      // persist-gate 守卫：persist 未完成时禁止推进
      if (!canAdvanceTurn(ctx)) {
        if (!ctx.persistCompleted) return '持久化未完成，无法推进下一回合'
        return `当前阶段为 ${phase}，无法推进下一回合`
      }
      return null

    case 'SUBMIT_ORDER':
      if (!canSubmitOrder(phase)) return `当前阶段为 ${phase}，无法提交命令`
      return null

    case 'CONFIRM_ORDER':
      if (phase !== 'handshake') return `当前阶段为 ${phase}，无法确认命令`
      return null

    case 'RESOLUTION_FAILED':
      if (phase !== 'resolution') return `当前阶段为 ${phase}，无法标记结算失败`
      return null

    case 'PERSIST_FAILED':
      if (phase !== 'persist') return `当前阶段为 ${phase}，无法标记持久化失败`
      return null

    case 'RETRY':
      // 通用重试，任何非 idle 阶段都允许（idle 无需重试）
      return null

    case 'LOAD_CONTEXT':
      return null

    case 'SET_WORLD':
      // 第 6 批：胜负评估后注入新 world（累计统计 + victoryState）。
      // 任何阶段都允许（纯 world 替换，不改 phase）；编排器在 FINISH_RESOLUTION 后调用。
      return null

    default: {
      // 穷尽性检查：未覆盖的动作判未知
      const _exhaustive: never = action
      void _exhaustive
      return `未知动作类型`
    }
  }
}

/**
 * 判断某动作在当前阶段是否被守卫放行（仅基于 phase 的便捷版本）。
 * UI 按钮禁用用此；reducer 内部用 guardAction（含 persistCompleted）。
 */
export function isActionAllowed(
  phase: GamePhase,
  action: StateMachineAction['type'],
): boolean {
  const simple = {
    START_TURN: 'idle',
    ENTER_HANDSHAKE: 'planning',
    CONFIRM_HANDSHAKE: 'handshake',
    LOCK_ORDERS: 'handshake',
    ENTER_RESOLUTION: 'locked',
    FINISH_RESOLUTION: 'resolution',
    ENTER_PERSIST: 'briefing',
    OFFER_DECISION: 'briefing',
    RESOLVE_DECISION: 'decision',
    PERSIST_COMPLETE: 'persist',
    RESOLUTION_FAILED: 'resolution',
    PERSIST_FAILED: 'persist',
  } as const
  const required = simple[action as keyof typeof simple]
  return required === undefined ? true : required === phase
}

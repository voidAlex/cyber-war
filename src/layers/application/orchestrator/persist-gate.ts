/**
 * 持久化门控（persist-gate.ts）。
 *
 * 对应重写计划关键防坑「persist 被 UI 跳过、10s 轮询丢档」：
 * - reducer 内 NEXT_TURN 受 persistCompleted 守卫（见 guard.ts / reducer.ts），
 *   persist 未完成时返回 error，无法进下一回合。
 * - advanceTurn 中落盘 `await`（非 fire-and-forget），见 turn-orchestrator.ts。
 * - UI 推进按钮必须走 orchestrator，禁直接 dispatch NEXT_TURN。
 *
 * 本文件提供运行时辅助：校验当前上下文是否已满足推进前置条件。
 *
 * @module layers/application/orchestrator/persist-gate
 */

import type { StateMachineContext } from '@/layers/application/state-machine/types'
import { canAdvanceTurn } from '@/layers/application/state-machine/guard'

/**
 * 强制等待持久化完成（persist-gate 运行时校验）。
 *
 * 与 reducer 守卫形成双保险：reducer 在纯函数层拦截非法 NEXT_TURN，
 * 此函数在 orchestrator 层提供 await 形态的前置检查（便于 advanceTurn
 * 编排时显式 gate）。
 *
 * @param ctx 当前状态机上下文
 * @returns true=已满足推进前置条件（idle + persistCompleted）
 */
export function isPersistGateSatisfied(ctx: StateMachineContext): boolean {
  return canAdvanceTurn(ctx)
}

/**
 * 断言 persist-gate 已满足；不满足时抛错（供 orchestrator 防御式编程）。
 *
 * @param ctx 当前状态机上下文
 * @throws Error 当 persist 未完成或非 idle 阶段
 */
export function assertPersistGate(ctx: StateMachineContext): void {
  if (!isPersistGateSatisfied(ctx)) {
    throw new Error(
      `persist-gate 未满足：phase=${ctx.game.phase}, persistCompleted=${ctx.persistCompleted}`,
    )
  }
}

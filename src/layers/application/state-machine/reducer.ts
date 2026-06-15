/**
 * 状态机 reducer（reducer.ts）— **纯函数**（铁律边界）。
 *
 * 铁律（AGENTS.md「纯/React 边界」）：本文件不得调用 Tauri/fetch/crypto，
 * 不得调用 Date.now()/随机数。所有副作用（落盘/LLM/Worker）由
 * orchestrator/services 显式编排，本 reducer 只做 (ctx, action) → ctx。
 *
 * 借鉴 src-legacy/game/state-machine.ts 的 wegoReducer 骨架，重写时：
 * - 严格剥离副作用（删 new Date() / 删时间戳写入）。
 * - 守卫不满足时返回 {...ctx, error}（不默默执行），对应审计教训。
 * - persist-gate：NEXT_TURN 受 persistCompleted 守卫。
 * - 确定性预留：action 顺序固定，reducer 输出与调度顺序无关。
 *
 * 状态机线性链：
 *   idle → planning → handshake → locked → resolution → briefing → persist → idle
 *   （+ resolution→locked / persist→briefing 失败回路）
 *
 * @module layers/application/state-machine/reducer
 */

import type {
  GamePhase,
  WorldState,
  ActionEnvelope,
} from '@/types'
import type {
  StateMachineAction,
  StateMachineContext,
  ReducerResult,
} from './types'
import { guardAction } from './guard'

/**
 * 创建初始状态机上下文（从 WorldState 起步，phase=idle）。
 *
 * @param world 起始世界状态
 * @param phase 初始阶段（默认 idle，从存档恢复时可为 briefing/persist 等）
 */
export function createInitialContext(
  world: WorldState,
  phase: GamePhase = 'idle',
): StateMachineContext {
  return {
    game: { phase, world },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    persisting: false,
    persistCompleted: false,
    pendingDecision: null,
    error: null,
  }
}

/**
 * 工具：返回守卫拒绝结果（保持 state 引用不变，填 error）。
 */
function rejected(
  ctx: StateMachineContext,
  message: string,
): ReducerResult & { state: StateMachineContext } {
  return {
    ok: false,
    error: message,
    fromPhase: ctx.game.phase,
    state: ctx, // 引用不变
  }
}

/**
 * 工具：返回成功结果（带新 state）。
 */
function accepted(
  ctx: StateMachineContext,
  fromPhase: GamePhase,
): ReducerResult & { state: StateMachineContext } {
  return {
    ok: true,
    error: null,
    fromPhase,
    state: ctx,
  }
}

/**
 * WEGO 状态机 reducer（纯函数）。
 *
 * 流程：
 * 1. guardAction 守卫判定 —— 不满足直接返回 rejected（含 error）。
 * 2. 合法迁移校验 —— 用 isValidTransition 复核 phase→phase 迁移。
 * 3. 不可变更新产出新 ctx（含 phase/world 变更）。
 *
 * @param ctx 当前状态机上下文
 * @param action 状态机动作
 * @returns reducer 执行结果封装（含新状态与守卫结果）
 */
export function wegoReducer(
  ctx: StateMachineContext,
  action: StateMachineAction,
): ReducerResult & { state: StateMachineContext } {
  // 1. 守卫判定（含 persist-gate 对 NEXT_TURN 的拦截）
  const guardError = guardAction(ctx, action)
  if (guardError !== null) {
    return rejected(ctx, guardError)
  }

  const fromPhase = ctx.game.phase

  switch (action.type) {
    case 'START_TURN': {
      // idle → planning（开始新回合规划）
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'planning' },
        pendingOrders: [],
        lockedOrders: {},
        persistCompleted: false,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'ENTER_HANDSHAKE': {
      // planning → handshake
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'handshake' },
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'CONFIRM_HANDSHAKE':
    case 'LOCK_ORDERS': {
      // handshake → locked（命令锁定；pendingOrders 清入 lockedOrders）
      const lockedOrders: Record<string, ActionEnvelope[]> = { ...ctx.lockedOrders }
      for (const env of ctx.pendingOrders) {
        const list = lockedOrders[env.faction] ?? []
        list.push(env)
        lockedOrders[env.faction] = list
      }
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'locked' },
        pendingOrders: [],
        lockedOrders,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'ENTER_RESOLUTION': {
      // locked → resolution
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'resolution' },
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'FINISH_RESOLUTION': {
      // resolution → briefing（写入结算结果；M1 空回合 events 为空但仍走完）
      // 可选：resolver 注入应用了情报增量的新 world（recon 命中后让 UI 实时看到 level 提升）
      // M4-D：可选注入上下文压缩产物，更新 worldState.contextSummaries（新 L2 稳定前缀）
      const summary = action.contextSummary
      // 起点 world：优先用 resolver 注入的 world（已含 detection/reconHits 增量），
      // 否则沿用 ctx 原 world。
      const baseWorld = action.world ?? ctx.game.world
      const world =
        summary !== undefined
          ? {
              ...baseWorld,
              contextSummaries: {
                ...baseWorld.contextSummaries,
                [summary.turn]: summary.text,
              },
            }
          : baseWorld
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'briefing', world },
        lastResolution: action.resolution,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'ENTER_PERSIST': {
      // briefing → persist（标记 persisting=true，UI 禁用推进按钮）
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'persist' },
        persisting: true,
        persistCompleted: false,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'OFFER_DECISION': {
      // briefing → decision（导演部产出 pendingDecision，挂起等玩家选择）
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'decision' },
        pendingDecision: action.decision,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'RESOLVE_DECISION': {
      // decision → persist（玩家选择或跳过）
      // 把所选选项的后果 overrides（DirectorOverride[]）应用到 world.units。
      // 跳过（optionId=null）时 overrides 为空，world 不变。
      const world = applyDecisionOverrides(ctx.game.world, action.overrides)
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'persist', world },
        pendingDecision: null,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'PERSIST_COMPLETE': {
      // persist → idle（落盘完成；置 persistCompleted=true 放行 NEXT_TURN）
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'idle' },
        persisting: false,
        persistCompleted: true,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'NEXT_TURN': {
      // idle → idle，turnIndex+1，清空本回合运行时；persistCompleted 守卫已过
      const world: WorldState = {
        ...ctx.game.world,
        turnIndex: ctx.game.world.turnIndex + 1,
      }
      const next: StateMachineContext = {
        ...ctx,
        game: { phase: 'idle', world },
        pendingOrders: [],
        lockedOrders: {},
        // 注意：不重置 persistCompleted——但本回合已推进，下一轮 START_TURN 会重置
        persistCompleted: true,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'SUBMIT_ORDER': {
      // planning/handshake → 同阶段（命令入 pendingOrders 队列）
      const next: StateMachineContext = {
        ...ctx,
        pendingOrders: [...ctx.pendingOrders, action.envelope],
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'CONFIRM_ORDER': {
      // handshake → 同阶段（标记某命令为 confirmed，M2 用）
      const pendingOrders = ctx.pendingOrders.map((env) =>
        env.sequence.toString() === action.envelopeId
          ? { ...env, state: 'confirmed' as const }
          : env,
      )
      const next: StateMachineContext = {
        ...ctx,
        pendingOrders,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'RESOLUTION_FAILED': {
      // resolution → locked（结算失败回路）
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'locked' },
        error: action.reason,
      }
      return accepted(next, fromPhase)
    }

    case 'PERSIST_FAILED': {
      // persist → briefing（落盘失败回路，回到战报等待重试）
      const next: StateMachineContext = {
        ...ctx,
        game: { ...ctx.game, phase: 'briefing' },
        persisting: false,
        persistCompleted: false,
        error: action.reason,
      }
      return accepted(next, fromPhase)
    }

    case 'RETRY': {
      // 通用重试：清除 error，phase 不变（由调用方决定后续动作）
      const next: StateMachineContext = {
        ...ctx,
        error: null,
      }
      return accepted(next, fromPhase)
    }

    case 'LOAD_CONTEXT': {
      // 从存档恢复：直接替换整个上下文
      return accepted(action.context, fromPhase)
    }

    default: {
      // 穷尽性检查
      const _exhaustive: never = action
      void _exhaustive
      return rejected(ctx, '未知动作类型')
    }
  }
}

// —— reducer 内主守卫由 guardAction 完成；
//    迁移表 isValidTransition 供 guard/transitions 复核，本文件不再直接引用。

// =============================================================================
// 第 3 批：战术决策后果应用（纯函数，复用 DirectorOverride → Unit 字段路径语义）
// =============================================================================

/**
 * 把战术决策的后果 overrides（DirectorOverride[]）应用到 world.units。
 *
 * 纯函数 + 不可变产出。field 路径约定 `units.<unitId>.<field>`
 * （与 director.applyOverridesToResult / replay.applyTrustedAction 同构）。
 *
 * 仅修改真实存在的单位（绝不伪造单位）；非法路径跳过。
 * 应用到 Unit 的数值字段（strength/morale/fatigue/fuel/ammo/personnel）。
 *
 * 注：此处的"应用"是把 after 值直接写到 world.units（与 director 的 finalResult.stateChanges
 * 分开，因战术决策发生在物理结算之后的 decision 阶段，绕过 stateChanges 增量链路）。
 */
function applyDecisionOverrides(
  world: WorldState,
  overrides: readonly import('@/layers/agents/protocol/schema').DirectorOverride[],
): WorldState {
  if (overrides.length === 0) return world
  const newUnits = world.units.map((unit) => ({ ...unit }))
  let changed = false
  for (const ov of overrides) {
    const parsed = parseDecisionField(ov.field)
    if (!parsed) continue
    const { unitId, field } = parsed
    const idx = newUnits.findIndex((u) => u.id === unitId)
    if (idx < 0) continue
    const record = newUnits[idx] as unknown as Record<string, unknown>
    record[field] = ov.after
    changed = true
  }
  if (!changed) return world
  return { ...world, units: newUnits }
}

/** 解析 override field 路径 `units.<unitId>.<field>` → { unitId, field }。 */
function parseDecisionField(
  field: string,
): { unitId: string; field: string } | null {
  const parts = field.split('.')
  if (parts.length < 3) return null
  if (parts[0] !== 'units') return null
  return { unitId: parts[1], field: parts.slice(2).join('.') }
}

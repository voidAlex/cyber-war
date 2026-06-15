/**
 * 状态机类型契约（types.ts）— 纯函数 reducer 的输入/输出类型定义。
 *
 * 设计要点（对应重写计划「状态机实现方案」与审计教训）：
 * - reducer 是纯函数，本文件只定义数据形态，不含任何运行时副作用。
 * - StateMachineContext 持有 GameState（含 phase/world）+ 状态机运行时
 *   （待确认命令、已锁定命令、上一回合结算、persist 标记、error、abort）。
 * - StateMachineAction 为判别联合，每个动作对应一个状态机迁移。
 *
 * 状态机线性链（含失败回路）：
 *   idle → planning → handshake → locked → resolution → briefing → persist → idle
 *   resolution → locked（结算失败回退）
 *   persist → briefing（落盘失败回退，再次展示战报等待重试）
 *
 * 确定性预留：action 顺序固定（reducer 不依赖调度顺序），为后续
 * seed=scenarioSeed:turn:sequence 的确定性回放留好骨架。
 *
 * @module layers/application/state-machine/types
 */

import type {
  GamePhase,
  WorldState,
  ResolutionSummary,
} from '@/types'
import type { ActionEnvelope } from '@/types'

/**
 * reducer 执行结果封装（含可能的守卫错误）。
 *
 * 纯函数返回，不发起任何副作用。守卫不通过时 ok=false 且 state 原样返回
 * （保持引用），上层据 error 反馈 UI。
 */
export interface ReducerResult {
  /** 是否成功推进（守卫通过并产生新状态） */
  ok: boolean
  /** 失败时的守卫错误信息（成功为 null） */
  error: string | null
  /** 涉及的源阶段（用于 UI 反馈） */
  fromPhase: GamePhase
}

/**
 * 状态机上下文（reducer 的全部输入与输出）。
 *
 * 与 GameState 的区别：GameState 是「对外暴露的游戏状态」，
 * StateMachineContext 是「reducer 内部完整的运行时」。
 * 两者通过 context.game 字段桥接，store 持有 context。
 */
export interface StateMachineContext {
  /** 游戏状态（含 phase/world，对外真相源） */
  game: {
    phase: GamePhase
    world: WorldState
  }
  /** 待确认命令队列（planning/handshake 阶段填充） */
  pendingOrders: ActionEnvelope[]
  /** 已锁定命令（按 factionId 索引；locked 阶段冻结） */
  lockedOrders: Record<string, ActionEnvelope[]>
  /** 上一回合结算结果（briefing 阶段展示） */
  lastResolution: ResolutionSummary | null
  /** 是否正在持久化（persist-gate 守卫用，UI 禁用推进按钮） */
  persisting: boolean
  /** persist 是否已完成落盘（PERSIST_COMPLETE 后置 true，NEXT_TURN 前置守卫） */
  persistCompleted: boolean
  /** 最近一次错误（状态机内判，UI 展示；null=无错误） */
  error: string | null
}

/**
 * 状态机动作判别联合。
 *
 * 设计原则：
 * - 每个动作对应一次确定的状态迁移，reducer 内做 phase 守卫。
 * - 守卫不满足时 reducer 返回 {...ctx, error}（不默默执行，对应审计
 *   「命令提交无视阶段」「NEXT_TURN 无 phase 守卫」）。
 * - M1 空回合链路：START_TURN → ENTER_HANDSHAKE → CONFIRM_HANDSHAKE →
 *   LOCK_ORDERS → ENTER_RESOLUTION → FINISH_RESOLUTION → ENTER_PERSIST →
 *   PERSIST_COMPLETE → NEXT_TURN。
 * - NEXT_TURN 受 persist-gate 守卫：persistCompleted=false 时返回 error。
 *
 * 注：SUBMIT_ORDER/CONFIRM_ORDER 在 M1 空转演示中非必需，但保留以让
 * guard 守卫规则可单测（canSubmitOrder / canConfirmHandshake）。
 */
export type StateMachineAction =
  // —— 主链路（M1 空转闭环）——
  | { type: 'START_TURN' } // idle → planning
  | { type: 'ENTER_HANDSHAKE' } // planning → handshake
  | { type: 'CONFIRM_HANDSHAKE' } // handshake → locked
  | { type: 'LOCK_ORDERS' } // handshake → locked（命令锁定；与 CONFIRM_HANDSHAKE 等价，保留语义别名供 UI 选择）
  | { type: 'ENTER_RESOLUTION' } // locked → resolution
  | {
      type: 'FINISH_RESOLUTION'
      resolution: ResolutionSummary
      /**
       * 可选：结算后应用了情报增量（detection/reconHits）的新 world。
       * resolver 在结算 recon 命中后注入，让 briefing 阶段 UI 立即看到
       * 被侦察区域的敌方 level 提升（无需 reload）。缺失时沿用原 world。
       */
      world?: WorldState
      // M4-D 上下文压缩（每 5 回合）：可选的压缩产物，更新 worldState.contextSummaries。
      // 仅当 shouldCompressContext(turn) 时由编排器注入；缺失时不改 contextSummaries。
      contextSummary?: { turn: number; text: string }
    } // resolution → briefing
  | { type: 'ENTER_PERSIST' } // briefing → persist
  | { type: 'PERSIST_COMPLETE' } // persist → idle（persist-gate 守卫此信号，置 persistCompleted=true）
  | { type: 'NEXT_TURN' } // idle → idle 且 turnIndex+1（受 persistCompleted 守卫）
  // —— 命令链路（M2 接入，M1 保留守卫可测）——
  | { type: 'SUBMIT_ORDER'; envelope: ActionEnvelope } // planning/handshake 提交命令
  | { type: 'CONFIRM_ORDER'; envelopeId: string } // handshake 确认入队
  // —— 失败回路 ——
  | { type: 'RESOLUTION_FAILED'; reason: string } // resolution → locked
  | { type: 'PERSIST_FAILED'; reason: string } // persist → briefing
  | { type: 'RETRY'; reason: string } // 通用失败重试（回自身或上一阶段）
  // —— 恢复 ——
  | { type: 'LOAD_CONTEXT'; context: StateMachineContext } // 从存档恢复完整上下文

/**
 * 注入的时钟函数类型（保持 reducer 纯净，禁止直接调 Date.now）。
 * M1 空回合不真正用时钟；为后续确定性/可测预留。
 */
export type ClockFn = () => number

/**
 * 注入的 id 生成器类型（保持 reducer 纯净，禁止直接调随机数）。
 */
export type IdGenFn = () => string

/**
 * 游戏状态类型定义（含 GamePhase）
 *
 * 状态机线性链：
 *   idle → planning → handshake → locked → resolution → briefing → persist → idle
 *   （+ 失败重试回路）
 *
 * 这是 application/state-machine 的状态契约；reducer 是纯函数，
 * guard.ts 守卫命令提交阶段，persist-gate 强制落盘。
 *
 * @module types/game-state
 */

import type { WorldState } from './world-state'

/**
 * WEGO 回合阶段枚举。
 *
 * - idle：空闲，等待开始新回合
 * - planning：规划期，玩家观察沙盘、与参谋长对话、下达指令
 * - handshake：握手期，参谋长反问、预演虚线、玩家确认
 * - locked：锁定期，双方计划冻结，准备结算
 * - resolution：结算期，导演部接管结算
 * - briefing：战报期，战报分发、沙盘更新、情报半衰
 * - persist：持久化期，world-state 落盘 + 快照
 */
export type GamePhase =
  | 'idle'
  | 'planning'
  | 'handshake'
  | 'locked'
  | 'resolution'
  | 'briefing'
  | 'persist'

/**
 * 状态机 reducer 的动作判别联合（纯函数 reducer 的输入）。
 *
 * 设计要点：reducer 是纯函数，不在此发起任何副作用；
 * 副作用（落盘/LLM/Worker）由 orchestrator/services 显式编排。
 */
export type StateMachineAction =
  | { type: 'START_TURN' } // idle → planning
  | { type: 'SUBMIT_ORDER'; envelopeId: string } // planning/handshake 提交命令
  | { type: 'ENTER_HANDSHAKE' } // planning → handshake
  | { type: 'CONFIRM_ORDER'; envelopeId: string } // handshake 确认入队
  | { type: 'LOCK_ORDERS' } // handshake → locked
  | { type: 'ENTER_RESOLUTION' } // locked → resolution
  | {
      // resolution → briefing
      type: 'FINISH_RESOLUTION'
      resolution: import('./world-state').ResolutionSummary
      /**
       * 可选：结算后应用了情报增量（detection/reconHits）的新 world。
       * resolver 在结算 recon 命中后注入，让 briefing 阶段 UI 立即看到
       * 被侦察区域的敌方 level 提升（无需 reload）。缺失时沿用原 world。
       */
      world?: import('./world-state').WorldState
      // M4-D 上下文压缩（每 5 回合）：可选的压缩产物，更新 worldState.contextSummaries。
      contextSummary?: { turn: number; text: string }
    }
  | { type: 'ENTER_PERSIST' } // briefing → persist
  | { type: 'PERSIST_COMPLETE' } // persist → idle（persist-gate 守卫此信号）
  | { type: 'RETRY'; reason: string } // 失败重试回路
  | { type: 'LOAD_STATE'; state: GameState } // 从存档恢复

/**
 * 游戏状态接口（状态机 + 世界状态）。
 *
 * 与 WorldState 的区别：
 * - WorldState：游戏数据（阵营/单位/地图），可序列化为 world-state.json。
 * - GameState：= WorldState + 状态机运行时（phase / error / persisting）。
 */
export interface GameState {
  /** 当前游戏阶段 */
  phase: GamePhase
  /** 世界状态（唯一真相源） */
  world: WorldState
  /** 是否正在持久化（persist-gate 用，UI 禁用推进按钮） */
  persisting: boolean
  /** 最近一次错误（状态机内判，UI 展示） */
  error: { phase: GamePhase; message: string } | null
}

/** 当前游戏版本号（数据迁移用） */
export const GAME_VERSION = '0.1.0' as const

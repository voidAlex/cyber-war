/**
 * 游戏全局 store（game-store.ts）— 单一外部状态（zustand）。
 *
 * 职责（AGENTS.md 关键依赖：zustand）：
 * - 持有 StateMachineContext（reducer 的全部输入/输出）。
 * - 提供 dispatch（封装 wegoReducer）与 selector。
 * - 提供 loadGame / 列存档等副作用编排出口（调 persistence-service/orchestrator）。
 *
 * UI 通过 selector 订阅；推进回合必须走 advanceTurn（persist-gate 强制），
 * 禁直接 dispatch NEXT_TURN（对应重写计划关键防坑）。
 *
 * @module store/game-store
 */

import { create } from 'zustand'
import type { StateMachineContext, StateMachineAction } from '@/layers/application/state-machine/types'
import { wegoReducer } from '@/layers/application/state-machine/reducer'
import { persistenceService } from '@/layers/application/services/persistence-service'
import { advanceTurn, createDefaultResolver } from '@/layers/application/orchestrator/turn-orchestrator'
import { initWorkerService } from '@/layers/application/services/worker-service'
import { directorRole } from '@/layers/agents/roles/director'
import type { WorldState } from '@/types'

/**
 * 物理引擎 Worker 客户端（单例，主线程持有 Worker 句柄）。
 *
 * 模块级实例：Worker 构造代价较高，整个应用生命周期复用一个 client。
 * 测试环境（vitest）不 import 本 store，故不会拉起 Worker。
 */
const physicsClient = initWorkerService()

/**
 * M2 默认结算器：物理引擎 Worker + 导演部 mock 终裁。
 * 注入 advanceTurn 的 services.resolve。
 */
const defaultResolver = createDefaultResolver(physicsClient, directorRole)

/**
 * Store 状态形态。
 */
export interface GameStoreState {
  /** 当前状态机上下文（null=未加载任何存档） */
  context: StateMachineContext | null
  /** 当前存档 id（null=未选择存档） */
  saveId: string | null
  /** 存档列表（SaveListPanel 渲染） */
  saves: string[]
  /** 异步操作进行中标志（UI 禁用按钮） */
  busy: boolean
  /** 最近一次面向用户的错误消息（null=无） */
  userError: string | null

  // —— 动作 ——
  /** dispatch 一个纯 action 到 reducer（守卫拒绝时设 userError） */
  dispatch: (action: StateMachineAction) => boolean
  /** 刷新存档列表 */
  refreshSaves: () => Promise<void>
  /** 创建新存档并载入 */
  createSave: (saveId: string, displayName: string) => Promise<void>
  /** 载入已有存档（从 world-state 恢复 StateMachineContext） */
  loadSave: (saveId: string) => Promise<void>
  /** 删除存档 */
  deleteSave: (saveId: string) => Promise<void>
  /** 推进一个完整回合（走 advanceTurn，persist-gate 强制落盘） */
  advance: () => Promise<void>
  /** 直接从 WorldState 设置上下文（测试/恢复用） */
  setFromWorld: (world: WorldState, saveId?: string) => void
  /** 清除 userError */
  clearError: () => void
}

/**
 * zustand store（唯一外部状态）。
 *
 * 注意：副作用编排（落盘/列存档）在 store 动作内调用 persistence-service，
 * 真正的 Tauri 调用仍在 gateway 层（本文件不 import @tauri-apps/api）。
 */
export const useGameStore = create<GameStoreState>((set, get) => ({
  context: null,
  saveId: null,
  saves: [],
  busy: false,
  userError: null,

  dispatch(action) {
    const ctx = get().context
    if (ctx === null) {
      set({ userError: '尚未加载存档，无法操作' })
      return false
    }
    const result = wegoReducer(ctx, action)
    if (!result.ok) {
      set({ userError: result.error })
      return false
    }
    set({ context: result.state, userError: null })
    return true
  },

  async refreshSaves() {
    set({ busy: true })
    try {
      const saves = await persistenceService.listSaves()
      set({ saves, busy: false })
    } catch (err) {
      set({ busy: false, userError: `读取存档列表失败：${String(err)}` })
    }
  },

  async createSave(saveId, displayName) {
    set({ busy: true, userError: null })
    try {
      const world = await persistenceService.createSave({
        saveId,
        scenarioId: 'm1-skeleton',
        displayName,
      })
      // 创建后即载入：构造初始 idle 上下文
      const ctx: StateMachineContext = {
        game: { phase: 'idle', world },
        pendingOrders: [],
        lockedOrders: {},
        lastResolution: null,
        persisting: false,
        // 新建存档视为已落盘（createSave 内已写 world-state），允许 START_TURN
        persistCompleted: true,
        error: null,
      }
      const saves = await persistenceService.listSaves()
      set({ context: ctx, saveId, saves, busy: false })
    } catch (err) {
      set({ busy: false, userError: `创建存档失败：${String(err)}` })
    }
  },

  async loadSave(saveId) {
    set({ busy: true, userError: null })
    try {
      const world = await persistenceService.readWorldState(saveId)
      if (world === null) {
        set({ busy: false, userError: `存档 ${saveId} 无 world-state，可能已损坏` })
        return
      }
      // 刷新恢复：从 world-state 重建 idle 上下文（持久化已完成，允许推进）
      const ctx: StateMachineContext = {
        game: { phase: 'idle', world },
        pendingOrders: [],
        lockedOrders: {},
        lastResolution: null,
        persisting: false,
        persistCompleted: true,
        error: null,
      }
      set({ context: ctx, saveId, busy: false })
    } catch (err) {
      set({ busy: false, userError: `载入存档失败：${String(err)}` })
    }
  },

  async deleteSave(saveId) {
    set({ busy: true, userError: null })
    try {
      await persistenceService.deleteSave(saveId)
      const saves = await persistenceService.listSaves()
      const cur = get()
      // 若删除的是当前存档，清空上下文
      if (cur.saveId === saveId) {
        set({ context: null, saveId: null, saves, busy: false })
      } else {
        set({ saves, busy: false })
      }
    } catch (err) {
      set({ busy: false, userError: `删除存档失败：${String(err)}` })
    }
  },

  async advance() {
    const ctx = get().context
    if (ctx === null) {
      set({ userError: '尚未加载存档，无法推进回合' })
      return
    }
    set({ busy: true, userError: null })
    try {
      const result = await advanceTurn(ctx, {
        persistence: persistenceService,
        resolve: defaultResolver,
      })
      // advanceTurn 内部已 dispatch 全链路 + 落盘；将其最终上下文写回 store
      set({ context: result.context, busy: false })
    } catch (err) {
      // 落盘失败等：上下文可能已被部分推进，从 error.context 恢复（若存在）
      const maybeCtx = (err as { context?: StateMachineContext }).context
      if (maybeCtx) {
        set({ context: maybeCtx, busy: false, userError: `回合推进失败：${String(err)}` })
      } else {
        set({ busy: false, userError: `回合推进失败：${String(err)}` })
      }
    }
  },

  setFromWorld(world, saveId) {
    const ctx: StateMachineContext = {
      game: { phase: 'idle', world },
      pendingOrders: [],
      lockedOrders: {},
      lastResolution: null,
      persisting: false,
      persistCompleted: true,
      error: null,
    }
    set({ context: ctx, saveId: saveId ?? get().saveId })
  },

  clearError() {
    set({ userError: null })
  },
}))

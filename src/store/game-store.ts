/**
 * 游戏全局 store（game-store.ts）— 单一外部状态（zustand）。
 *
 * 职责（AGENTS.md 关键依赖：zustand）：
 * - 持有 StateMachineContext（reducer 的全部输入/输出）。
 * - 提供 dispatch（封装 wegoReducer）与 selector。
 * - 提供 loadGame / 列存档等副作用编排出口（调 persistence-service/orchestrator）。
 * - M3：持有运行时 LLM 配置解锁态、Agent 实时进度（agentProgressById）、
 *   流式战报直播文本（liveReport）、缓存命中统计（cacheStats）。
 *   这些是 UI 可观测状态，**不进 reducer**（保持 reducer 纯净可回放）。
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
import {
  advanceTurn,
  createMultiAgentResolver,
} from '@/layers/application/orchestrator/turn-orchestrator'
import { initWorkerService } from '@/layers/application/services/worker-service'
import { llmService } from '@/layers/application/services/llm-service'
import { errorToBanner } from '@/layers/application/services/llm-service'
import { createLlmTheaterRole, createLlmCommanderRole, createLlmDirectorRole } from '@/layers/agents/roles'
import { createTheaterRole, createCommanderRole, createDirectorRole } from '@/layers/agents/roles'
import type { TheaterRole, CommanderRole, DirectorRole } from '@/layers/agents/roles'
import {
  saveConfig as gatewaySaveConfig,
  loadConfig as gatewayLoadConfig,
  isSessionUnlocked,
  getSessionConfig,
  type RuntimeLLMConfig,
  RuntimeConfigError,
} from '@/layers/gateway/runtime-config'
import { verdunRules } from '@/data/verdun-1916/rules'
import type { WorldState, CampaignRules } from '@/types'
import type { CacheStats } from '@/layers/application/services/llm-service'
import type { LlmErrorBanner } from '@/layers/application/services/llm-service'
import type { ActionEnvelope, AgentRole } from '@/types'
import type { LlmCallConfig } from '@/layers/agents/roles'
import { logger } from '@/utils/logger'

/**
 * 物理引擎 Worker 客户端（单例，主线程持有 Worker 句柄）。
 *
 * 模块级实例：Worker 构造代价较高，整个应用生命周期复用一个 client。
 * 测试环境（vitest）不 import 本 store，故不会拉起 Worker。
 */
const physicsClient = initWorkerService()

/**
 * 内置战役包的 scenarioId → CampaignRules 查表（第 2 批随机事件用）。
 *
 * createMultiAgentResolver 经 getCampaignRules 按当前 world.scenarioId 取对应 rules，
 * rules.randomEvents 为空或未注册时本回合无随机事件（默认行为兼容）。
 * 后续支持 ZIP 导入战役包时，导入逻辑应在此注册其 rules（按 scenarioId）。
 */
const BUILTIN_CAMPAIGN_RULES: Record<string, CampaignRules> = {
  'verdun-1916': verdunRules,
}

/**
 * 按 scenarioId 查战役规则（第 2 批随机事件）。
 *
 * 优先查内置注册表；未注册返回 undefined（编排器据此跳过随机事件）。
 */
function getCampaignRulesByScenario(scenarioId: string): CampaignRules | undefined {
  return BUILTIN_CAMPAIGN_RULES[scenarioId]
}

/**
 * M3 多 Agent 结算器：物理引擎 + 多 Agent 编排（解锁时用 LLM 角色，否则 mock）。
 * buildMultiAgentResolver 构造具体实例（驱动进度条 + 流式战报），mock 角色保证离线可玩。
 */

/**
 * 构造 M3 多 Agent 结算器（带进度 + 流式战报回调）。
 *
 * - 若会话已解锁 LLM 配置：用 LLM 角色（theater/commander/director），真流式战报。
 * - 否则：用 mock 角色（M2 行为，但走多 Agent 编排路径以驱动进度条）。
 *
 * 进度回调绑定到 store 的 setAgentProgress；流式战报增量绑定到 appendLiveReport。
 * 返回的 resolver 同时把缓存统计与降级标志回写 store（供 Inspector / BriefingPanel）。
 */
function buildMultiAgentResolver(
  get: () => GameStoreState,
): NonNullable<Parameters<typeof advanceTurn>[1]['resolve']> {
  const llmConfig = buildLlmCallConfig()
  // 角色选择：有配置用 LLM，否则 mock（保证 M3 路径可用）
  const theaterRole: TheaterRole = llmConfig
    ? createLlmTheaterRole(llmService, llmConfig)
    : createTheaterRole()
  const commanderRole: CommanderRole = llmConfig
    ? createLlmCommanderRole(llmService, llmConfig)
    : createCommanderRole()
  const directorRoleInst: DirectorRole = llmConfig
    ? createLlmDirectorRole(llmService, llmConfig)
    : createDirectorRole()

  return createMultiAgentResolver({
    llmService,
    workerService: physicsClient,
    theaterRole,
    commanderRole,
    directorRole: directorRoleInst,
    llmConfig: llmConfig ?? undefined,
    // 第 2 批：按 scenarioId 动态查 rules（随机事件）
    getCampaignRules: getCampaignRulesByScenario,
    onProgress: (entry) => {
      // 把编排进度映射到 store.agentProgressById
      get().setAgentProgress({
        agentId: entry.agentId,
        role: entry.role,
        status: entry.status,
        partial: entry.partial,
        error: entry.error,
      })
    },
    onReportChunk: (chunk) => {
      get().appendLiveReport(chunk)
    },
  })
}

/**
 * 某个 Agent 在结算中的实时进度（UI 进度条/Inspector 用）。
 *
 * 不进 reducer（纯运行时可观测状态，非确定性回放内容）。
 */
export interface AgentProgressEntry {
  /** Agent id（如 chief-player / theater-blue / commander-red / director） */
  agentId: string
  /** Agent 角色 */
  role: AgentRole
  /** 阶段标签（思考中/并行中/裁定中/已完成/失败） */
  status: 'thinking' | 'running' | 'adjudicating' | 'done' | 'failed'
  /** 当前输出的原始 LLM 文本片段（流式累积，用于 Inspector 与直播） */
  partial?: string
  /** 解析后的结构化命令（briefing 后填充） */
  parsedEnvelope?: ActionEnvelope
  /** 置信度（0..1） */
  confidence?: number
  /** 错误信息（若失败） */
  error?: string
  /** prompt 分层估算（estimateCacheLayers 产出，供 Inspector） */
  layers?: {
    l0: number
    l1: number
    l2: number
    l3: number
  }
  /** 本次调用缓存命中 token 数 */
  cacheHitTokens?: number
  /** 本次调用缓存未命中 token 数 */
  cacheMissTokens?: number
}

/**
 * Store 状态形态。
 */
export interface GameStoreState {
  /** 当前状态机上下文（null=未加载任何存档） */
  context: StateMachineContext | null
  /** 当前存档 id（null=未选择存档） */
  saveId: string | null
  /** 存档列表（SaveListPanel 渲染；已过滤伪 saveId） */
  saves: string[]
  /** 异步操作进行中标志（UI 禁用按钮） */
  busy: boolean
  /** 最近一次面向用户的错误消息（null=无） */
  userError: string | null
  /** 最近一次四分类 LLM 错误（ErrorBanner 用；null=无） */
  llmError: LlmErrorBanner | null

  // —— M3 运行时 LLM 配置解锁态 ——
  /** 是否已加载过配置（存在落盘 config 文件 / keyring 记录） */
  hasConfig: boolean
  /** 是否已加载（会话内存持有明文 apiKey） */
  configUnlocked: boolean
  /** 加载后的明文配置（仅 provider/endpoint/model，apiKey 不放 store 避免泄漏） */
  config: { provider: string; endpoint: string; model: string } | null
  /**
   * legacy/no-api-key 时从旧 config 文件读到的非密钥字段（供 UI 预填表单）。
   * 用户重输 apiKey 后保存即清空。
   */
  pendingConfig: { provider: string; endpoint: string; model: string } | null
  /** keyring 降级警告（apiKey 降级明文文件时 Rust 返回；UI 顶部提示） */
  keyBackendWarning: string | null

  // —— M3 Agent 进度与流式战报（UI 可观测，非回放内容） ——
  /** 本回合各 Agent 实时进度（agentId → entry） */
  agentProgressById: Record<string, AgentProgressEntry>
  /** 导演部流式战报直播文本（边出边显示，TTFT<200ms 目标） */
  liveReport: string
  /** 是否正在流式输出战报 */
  streamingReport: boolean
  /** 本回合已产出的 envelopes（Inspector 展示用） */
  liveEnvelopes: ActionEnvelope[]
  /** 累计缓存命中统计（Inspector 展示命中率） */
  cacheStats: CacheStats
  /** 本回合是否降级结算（规则引擎兜底） */
  degraded: boolean

  // —— C 单位详情（UI 重构第 3 批）：选中单位 id ——
  // 沙盘点击单位 / 左栏 ForcesPanel 点击单位 → 写入此 id；
  // UnitDetailPanel 据此显示浮层，SandboxRenderer 据此画青光描边高亮。
  // null=未选中（关闭详情面板）。
  /**
   * 当前选中的单位 id（UnitDetailPanel + 沙盘高亮共用）。
   * 切换存档/回合推进不自动清空（保持选中态便于连续操作）。
   */
  selectedUnitId: string | null

  // —— 动作 ——
  /** dispatch 一个纯 action 到 reducer（守卫拒绝时设 userError） */
  dispatch: (action: StateMachineAction) => boolean
  /** 刷新存档列表（自动过滤伪 saveId） */
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

  // —— M3 配置与进度动作 ——
  /** 启动加载配置（读 config 文件 + keyring，无口令；按错误码设状态） */
  loadConfig: () => Promise<void>
  /** 保存配置（apiKey→keyring，非密钥字段→config 文件；回写降级警告） */
  saveConfig: (config: RuntimeLLMConfig) => Promise<void>
  /** 更新某 Agent 的实时进度（orchestrator onProgress 回调调用） */
  setAgentProgress: (entry: AgentProgressEntry) => void
  /** 追加流式战报文本片段 */
  appendLiveReport: (chunk: string) => void
  /** 标记流式战报开始/结束 */
  setStreamingReport: (streaming: boolean) => void
  /** 设置本回合 envelopes（briefing 后填充，Inspector 用） */
  setLiveEnvelopes: (envelopes: ActionEnvelope[]) => void
  /** 设置缓存统计（Inspector 用） */
  setCacheStats: (stats: CacheStats) => void
  /** 设置降级标志 */
  setDegraded: (degraded: boolean) => void
  /** 设置四分类 LLM 错误（ErrorBanner 用） */
  setLlmError: (err: LlmErrorBanner | null) => void
  /** 清空本回合进度/直播状态（新回合开始时） */
  resetTurnProgress: () => void

  // —— C 单位详情：选中单位动作 ——
  /** 选中某单位（写 selectedUnitId；UnitDetailPanel + 沙盘高亮响应）。 */
  setSelectedUnitId: (unitId: string | null) => void
  /** 清除选中单位（关闭 UnitDetailPanel）。 */
  clearSelectedUnit: () => void
}

// 存档过滤谓词（纯函数，从 save-filter 导入；拆分以避免测试 import store 时触发 Worker）
import { isPlayerSaveId } from './save-filter'
// 向后兼容 re-export（其他模块若从 store 引用谓词）
export { isPlayerSaveId } from './save-filter'

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
  llmError: null,

  hasConfig: false,
  configUnlocked: false,
  config: null,
  pendingConfig: null,
  keyBackendWarning: null,

  agentProgressById: {},
  liveReport: '',
  streamingReport: false,
  liveEnvelopes: [],
  cacheStats: {
    totalHitTokens: 0,
    totalMissTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    degradedCount: 0,
  },
  degraded: false,

  selectedUnitId: null,

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
      const all = await persistenceService.listSaves()
      // 过滤伪 saveId（runtime-config 占用），不展示给玩家
      const saves = all.filter(isPlayerSaveId)
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
      const all = await persistenceService.listSaves()
      const saves = all.filter(isPlayerSaveId)
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
      const all = await persistenceService.listSaves()
      const saves = all.filter(isPlayerSaveId)
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
    // 新回合开始：清空上一回合进度/直播/错误，重置缓存统计
    llmService.resetCacheStats()
    set({
      agentProgressById: {},
      liveReport: '',
      streamingReport: false,
      liveEnvelopes: [],
      degraded: false,
      llmError: null,
    })
    // 流式战报开始（编排期间 director 增量写入 liveReport）
    set({ streamingReport: true })
    try {
      // 多 Agent 结算器（带进度回调 + 流式战报；解锁时用 LLM 角色，否则 mock）
      const resolver = buildMultiAgentResolver(get)
      const result = await advanceTurn(ctx, {
        persistence: persistenceService,
        resolve: resolver,
      })
      // 结算完成：回写缓存统计、降级标志、envelopes（供 Inspector）
      set({
        context: result.context,
        busy: false,
        streamingReport: false,
        cacheStats: llmService.getCacheStats(),
        degraded: result.context.lastResolution?.degraded ?? false,
      })
    } catch (err) {
      set({ streamingReport: false })
      // 四分类 LLM 错误：映射为横幅（绝不把 ApiKey 误报为网络）
      const banner = errorToBanner(err)
      set({ llmError: banner, cacheStats: llmService.getCacheStats() })
      logger.error(
        'store/advance/failed',
        `回合推进失败（${banner.kind}）`,
        { scope: 'save', saveId: ctx.game.world.saveId, turn: ctx.game.world.turnIndex, kind: banner.kind },
      )
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
    set({ userError: null, llmError: null })
  },

  // ===========================================================================
  // M3 配置与进度动作
  // ===========================================================================

  async loadConfig() {
    // 会话内是否已加载（同进程内此前加载过则直接采信）
    if (isSessionUnlocked()) {
      set({
        configUnlocked: true,
        hasConfig: true,
        config: sessionConfigView(),
        pendingConfig: null,
        userError: null,
      })
      return
    }
    set({ busy: true, userError: null })
    try {
      const cfg = await gatewayLoadConfig()
      // 成功：会话内存持有明文 apiKey
      set({
        configUnlocked: true,
        hasConfig: true,
        config: { provider: cfg.provider, endpoint: cfg.endpoint, model: cfg.model },
        pendingConfig: null,
        userError: null,
        busy: false,
      })
    } catch (err) {
      if (err instanceof RuntimeConfigError) {
        const code = err.message
        if (code === 'no-config') {
          // 首次使用：无配置文件
          set({
            hasConfig: false,
            configUnlocked: false,
            config: null,
            pendingConfig: null,
            userError: null,
            busy: false,
          })
        } else if (code === 'legacy-encrypted' || code === 'no-api-key') {
          // 有配置但 apiKey 不可用：回写 pendingConfig 供 UI 预填表单
          const pending = err.pending
          set({
            hasConfig: true,
            configUnlocked: false,
            config: null,
            pendingConfig: pending
              ? { provider: pending.provider, endpoint: pending.endpoint, model: pending.model }
              : null,
            userError:
              code === 'legacy-encrypted'
                ? '检测到旧版加密配置（口令已废弃），请重新输入 API Key 以完成迁移。'
                : '已保存配置但 apiKey 不可用，请重新输入 API Key。',
            busy: false,
          })
        } else {
          // 配置损坏等其他错误
          set({ busy: false, userError: `加载配置失败：${err.message}` })
        }
      } else {
        set({ busy: false, userError: `加载配置失败：${String(err)}` })
      }
    }
  },

  async saveConfig(config) {
    set({ busy: true, userError: null })
    try {
      const outcome = await gatewaySaveConfig(config)
      // 成功：会话内存持有明文 apiKey；回写 keyring 降级警告
      set({
        hasConfig: true,
        configUnlocked: true,
        config: { provider: config.provider, endpoint: config.endpoint, model: config.model },
        pendingConfig: null,
        keyBackendWarning: outcome.warning,
        userError: outcome.warning ?? null,
        busy: false,
      })
    } catch (err) {
      set({ busy: false, userError: `保存配置失败：${String(err)}` })
    }
  },

  setAgentProgress(entry) {
    set((s) => ({
      agentProgressById: { ...s.agentProgressById, [entry.agentId]: entry },
    }))
  },

  appendLiveReport(chunk) {
    set((s) => ({ liveReport: s.liveReport + chunk }))
  },

  setStreamingReport(streaming) {
    set({ streamingReport: streaming })
  },

  setLiveEnvelopes(envelopes) {
    set({ liveEnvelopes: envelopes })
  },

  setCacheStats(stats) {
    set({ cacheStats: stats })
  },

  setDegraded(degraded) {
    set({ degraded })
  },

  setLlmError(err) {
    set({ llmError: err })
  },

  resetTurnProgress() {
    set({
      agentProgressById: {},
      liveReport: '',
      streamingReport: false,
      liveEnvelopes: [],
      degraded: false,
    })
  },

  setSelectedUnitId(unitId) {
    set({ selectedUnitId: unitId })
  },

  clearSelectedUnit() {
    set({ selectedUnitId: null })
  },
}))

/** 从会话取配置的非密钥视图（apiKey 不进 store） */
function sessionConfigView(): GameStoreState['config'] {
  const cfg = getSessionConfig()
  if (cfg === null) return null
  return { provider: cfg.provider, endpoint: cfg.endpoint, model: cfg.model }
}

/**
 * 构造 LlmCallConfig（供 M3 多 Agent resolver 用）。
 * 从会话取明文 apiKey（即用即抛，不进 store）。
 * 未解锁时返回 null（UI 应显示配置面板而非进入结算）。
 */
export function buildLlmCallConfig(): LlmCallConfig | null {
  const cfg = getSessionConfig()
  if (cfg === null) return null
  return {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    model: cfg.model,
    apiKey: cfg.apiKey,
  }
}

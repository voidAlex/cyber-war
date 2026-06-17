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
  resumeTurnAfterDecision,
  createMultiAgentResolver,
} from '@/layers/application/orchestrator/turn-orchestrator'
import type { DecisionResumeHandle } from '@/layers/application/orchestrator/turn-orchestrator'
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
// 第 5 批：内置战役 rules 注册表迁移到 src/data/registry（单一数据来源，
// 自动覆盖 5 个内置包）。本文件不再硬编码 verdunRules，避免每加新包都要改 store。
import { BUILTIN_CAMPAIGN_RULES } from '@/data/registry'
import type { WorldState, CampaignRules, DiplomaticRequest } from '@/types'
import type { CacheStats } from '@/layers/application/services/llm-service'
import type { LlmErrorBanner } from '@/layers/application/services/llm-service'
import type { ActionEnvelope, AgentRole, ParseCommandResult } from '@/types'
import type { LlmCallConfig } from '@/layers/agents/roles'
import { logger } from '@/utils/logger'
import {
  createTurnSnapshot,
  writeSnapshot,
} from '@/layers/persistence/snapshot'

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
 * 第 5 批：从 src/data/registry 复用单一注册表（覆盖凡尔登/官渡/俄乌/中途岛/美以伊），
 * createMultiAgentResolver 经 getCampaignRules 按当前 world.scenarioId 取对应 rules。
 * 后续支持 ZIP 导入战役包时，导入逻辑应在此注册其 rules（按 scenarioId）。
 */

/**
 * 按 scenarioId 查战役规则（第 2 批随机事件）。
 *
 * 优先查内置注册表；未注册返回 undefined（编排器据此跳过随机事件）。
 */
function getCampaignRulesByScenario(scenarioId: string): CampaignRules | undefined {
  return BUILTIN_CAMPAIGN_RULES[scenarioId]
}

/**
 * 第 2+3 批：按 scenarioId 查战役规则的**公共**入口（供 UI 层 DialogueStream
 * 读 rules.aiRoles 渲染角色 tab）。
 *
 * 与编排器用的 getCampaignRulesByScenario 同源（同一内置注册表），保证 UI 与
 * 编排器看到的 rules 一致。未注册返回 undefined（UI 据此退回默认 chief tab）。
 *
 * @param scenarioId 场景 id（如 'verdun-1916'）
 * @returns 战役规则或 undefined
 */
export function getCampaignRulesForScenario(scenarioId: string): CampaignRules | undefined {
  return getCampaignRulesByScenario(scenarioId)
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
    // 第 2 批：theater/commander resolve 流式 partial → store agentLiveOutputs（AgentInspector 实时）。
    onAgentDelta: (agentId, partial) => {
      get().setAgentLiveOutput(agentId, partial)
    },
  })
}

/**
 * Bug3 修复：参谋长对话条目（store 持久化用）。
 *
 * 与 useCommandDialogue 的 DialogueEntry 结构一致（input + reply），但定义在 store 层
 * （不反向依赖 UI hook），使对话记忆可跨组件重挂载持久。reply.source 区分 mock/llm，
 * DialogueStream 据此显示"离线模板/LLM"标签。
 *
 * 第 2+3 批扩展：加 `role` 字段标识该条对话归属哪个角色 tab（chief/diplomat/
 * commander-xxx），支持 `dialoguesByRole` 按角色分组历史。旧条目（无 role）按 'chief'
 * 兜底（向后兼容）。
 */
export interface DialogueEntry {
  /** 玩家原始问话/命令文本 */
  input: string
  /** 角色 id（如 'chief'/'diplomat'/'commander-artillery'；旧条目缺省按 'chief'） */
  role?: string
  /** 该角色回复（含 source: mock/llm） */
  reply: { text: string; source: 'mock' | 'llm' }
}

/** 对话历史上限（store 层常量；超出裁剪最早条目）。 */
export const DIALOGUE_LIMIT = 50

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

  // —— 第 5 批：创建战役独立页路由态 ——
  // App.tsx 第四态 creatorPage（configLock → titleScreen → creatorPage → inGame）。
  // 标题屏点「LLM 生成战役」→ setCreatorPageActive(true)；创建页退出/确认开局 → false。
  // 瞬态 UI 路由态，不进 reducer/context（不持久化）。
  /**
   * 是否显示创建战役独立页（App.tsx 第四态 creatorPage）。
   * true 时 App 渲染 CampaignCreatorPage；false 时回 titleScreen 态。
   */
  creatorPageActive: boolean

  // —— 第 3 批：沙盘 cell 悬浮 tooltip ——
  // 鼠标在沙盘上移动时，SandboxRenderer.handleStagePointer(move) 通过 onCellHover
  // 把当前 cellId 写入此处（null=鼠标移出网格）；CellTooltip 订阅此字段渲染悬浮信息。
  // 瞬态运行时数据，不进 reducer/context（纯 UI 可观测副作用）。
  /**
   * 当前悬浮的 cellId（如 "C3"，字母列+1起步行号）；null=未悬浮任何格。
   * 由 SandboxRenderer move 模式回调驱动，CellTooltip 读取渲染。
   */
  hoveredCellId: string | null
  /** 设置当前悬浮 cellId（沙盘 move 回调；null 清除）。 */
  setHoveredCellId: (cellId: string | null) => void

  // —— Bug3 修复：参谋长对话记忆持久化（store 持有，避免组件重挂载丢失）——
  // 原根因：dialogues 存在 useCommandDialogue 的 useState，组件因 context 变化/
  // 重挂载（DialogueStream/CommandTerminal 分别 useCommandDialogue 各自一份 state）
  // 导致对话历史丢失，chief.chat 的多轮上下文也随之断裂。
  // 修复：dialogues 提升到 store，中右两栏共享同一份，跨回合/跨重挂载持久。
  // 退出游戏（handleExit）时清空（store reset）。
  //
  // 第 2+3 批「角色 tab 对话」：dialogues 改为按角色分组的 dialoguesByRole
  // （Record<roleId, DialogueEntry[]>），每角色 tab 独立历史，切换 tab 不影响。
  // dialogues 字段保留为 chief 角色的派生镜像（= dialoguesByRole['chief']），
  // 向后兼容现有 useCommandDialogue 的 chief.chat 历史读取（chief 是默认 tab）。
  /**
   * 当前激活的角色 tab id（默认 'chief'；'diplomat'/'commander-xxx' 等）。
   * DialogueStream 顶部 tab 栏 setActiveRole 切换；dialoguesByRole[activeRoleId]
   * 即当前 tab 渲染的对话历史。
   */
  activeRoleId: string
  /** 切换当前激活角色 tab（DialogueStream tab 点击时调用）。 */
  setActiveRole: (roleId: string) => void
  /**
   * 按角色分组的对话历史（roleId → DialogueEntry[]）。
   * 每角色 tab 独立，互不影响。各角色上限 DIALOGUE_LIMIT（超出裁剪最早）。
   */
  dialoguesByRole: Record<string, DialogueEntry[]>
  /**
   * 追加一条对话到指定角色 tab 历史（带上限 DIALOGUE_LIMIT，超出裁剪最早）。
   * 自动给 entry 补 role 字段（与 roleId 一致）。
   * 若 roleId === activeRoleId，同时刷新 dialogues 派生镜像。
   */
  appendDialogueByRole: (roleId: string, entry: DialogueEntry) => void
  /**
   * 参谋长对话历史（chief 角色镜像 = dialoguesByRole['chief']）。
   *
   * 第 2+3 批：保留为派生字段（appendDialogueByRole('chief', ...) 时同步更新），
   * 向后兼容 useCommandDialogue 的 chief.chat 多轮上下文读取。其他角色的历史
   * 不进此字段（仅经 dialoguesByRole 访问）。
   */
  dialogues: DialogueEntry[]
  /**
   * 追加一条 chief 对话（带上限 DIALOGUE_LIMIT，超出裁剪最早）。
   * 等价于 appendDialogueByRole('chief', entry)（兼容旧调用点）。
   */
  appendDialogue: (entry: DialogueEntry) => void
  /** 清空所有角色对话历史（退出游戏时调用）。 */
  clearDialogues: () => void

  // —— 第 2 批：chief 对话打字机流式（liveChat）——
  // chief.chat 产出回复时，onDelta 把每段 partial 累加到 liveChat.text；
  // DialogueStream 订阅 liveChat 渲染「正在输入」气泡（青光闪烁 + 逐字）。
  // 完成后 clearLiveChat + appendDialogue（完整文本入历史，转正常气泡）。
  // 瞬态运行时数据，不进 reducer/context（纯 UI 可观测副作用）。
  /**
   * 当前正在流式的对话回复（null=无进行中的流式）。
   * role 为发声角色（当前仅 'chief'，预留多角色流式）。
   */
  liveChat: { text: string; role: string } | null
  /** 开始一次流式对话（chief.chat 开始时调用，重置 liveChat）。 */
  setLiveChat: (role: string) => void
  /** 累加 liveChat.text（onDelta 每段回调时调用）。 */
  appendLiveChatDelta: (delta: string) => void
  /** 结束流式对话（完成后调用；完整回复由调用方 appendDialogue 入历史）。 */
  clearLiveChat: () => void

  // —— 第 2 批：theater/commander resolve 流式（agentLiveOutputs）——
  // 结算编排时 theater/commander 的 onDelta 把 partial 写入 agentLiveOutputs[agentId]；
  // AgentInspector 据此显示各 Agent 实时输出（partial text）。
  // 瞬态运行时数据，不进 reducer/context；resetTurnProgress 时清空。
  /**
   * 各 Agent 当前流式输出的实时 partial（agentId → 已累积文本）。
   * key 存在且 value 非空表示该 Agent 正在流式产出。
   */
  agentLiveOutputs: Record<string, string>
  /** 设置某 Agent 的实时 partial（onDelta 回调；partial 为空时删除该 key）。 */
  setAgentLiveOutput: (agentId: string, partial: string) => void
  /** 清空所有 Agent 实时 partial（resetTurnProgress 调用）。 */
  clearAgentLiveOutputs: () => void

  // —— 命令候选共享（与 dialogues 同类问题：candidate 须跨中右两栏共享）——
  // 中栏 DialogueStream 输入并解析命令 → setCandidate；右栏 CommandTerminal 读
  // candidate 渲染候选卡 + 确认入队。若 candidate 是各组件 useState，右栏永远 null
  // → 候选卡不显示 → 无法确认入队 → 命令流程彻底阻断（比 4 bug 更致命）。
  // 提升 candidate 到 store，中右两栏共享同一份。
  /**
   * 当前候选命令（parseCommand 产物；null=无候选，clarify=需澄清，parsed=可确认入队）。
   * 中栏解析写入，右栏读取渲染候选卡。跨组件共享。
   */
  candidate: ParseCommandResult | null
  /** 设置候选命令（中栏解析后调用；null 清除） */
  setCandidate: (c: ParseCommandResult | null) => void

  // —— 第 3 批：战术决策挂起句柄 ——
  // advanceTurn 在导演部产出 pendingDecision 时挂起，返回此句柄。
  // 玩家在 DecisionPanel 选择后，store 据此调 resumeTurnAfterDecision 完成本回合。
  // 挂起期间 context.game.phase === 'decision'。
  // 瞬态运行时数据，不进 reducer/context（落盘仅经 event-log）。
  /** 决策挂起句柄（advanceTurn 暂停时填充，resumeTurnAfterDecision 完成后清空）。 */
  pendingDecisionHandle: DecisionResumeHandle | null

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
  /**
   * 第 3 批：解决战术决策（decision 阶段玩家选择后调用）。
   *
   * 流程：
   * 1. dispatch RESOLVE_DECISION（纯函数 reducer，应用所选选项 overrides 到 world）。
   * 2. 调 resumeTurnAfterDecision 完成本回合（decision → persist → idle → NEXT_TURN）。
   *
   * @param optionId 玩家选择的选项 id；null=跳过（不选，无后果）
   * @param overrides 所选选项的 overrides（与 RESOLVE_DECISION 同源；跳过时为空数组）
   */
  resolveDecision: (
    optionId: string | null,
    overrides: import('@/layers/agents/protocol/schema').DirectorOverride[],
  ) => Promise<void>
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

  // —— 第 5 批：创建战役独立页路由态 ——
  /** 切换创建战役独立页激活态（App.tsx 第四态 creatorPage）。 */
  setCreatorPageActive: (active: boolean) => void

  // —— 第 4 批：自动保存 UI 反馈（瞬态，不进 reducer/context）——
  // advance/resolveDecision persist 落盘成功后置位，Header 角标闪现"✓ 已保存"。
  // 3 秒后自动清除（由 markSaved 内 setTimeout 触发 clearSavedIndicator）。
  /** 最近一次落盘成功的回合索引（用于角标副信息；0 起）。 */
  lastSavedAt: number | null
  /** 是否显示"已保存"角标（advance/resolveDecision 落盘成功后 true，3s 后 false）。 */
  showSavedIndicator: boolean
  /** 标记本次落盘成功（置 showSavedIndicator=true + lastSavedAt，3s 后自动清除）。 */
  markSaved: (turnIndex: number) => void
  /** 清除"已保存"角标（markSaved 的 setTimeout 回调用）。 */
  clearSavedIndicator: () => void

  // —— 第 5 批：开场参谋长简报弹窗（OpeningBriefing）——
  // 新战役开局（createSave / 内置包开局 / 导入 ZIP 战役包开局）时置 true，
  // App.tsx 据此叠加 OpeningBriefing；玩家点击"开始指挥"调 dismissOpeningBriefing 置 false。
  // 旧存档加载（loadSave）不置位（避免每次进存档都弹简报，符合验收）。
  // 瞬态 UI 路由态，不进 reducer/context（不持久化）。
  /**
   * 是否显示开场参谋长简报弹窗。
   * 新战役创建时 true（createSave/内置包开局）；旧存档加载时 false。
   */
  showOpeningBriefing: boolean
  /** 标记需要显示开场简报（新战役开局后调用）。 */
  markOpeningBriefing: () => void
  /** 关闭开场简报（玩家点击"开始指挥"时调用）。 */
  dismissOpeningBriefing: () => void

  // —— 第 6 批：胜负终局弹窗（GameOverModal）——
  // advanceTurn 结算后如 world.victoryState !== 'ongoing' → setShowGameOver(true)。
  // App.tsx 据此叠加 GameOverModal（最高优先级，覆盖一切）。dismissGameOver 关闭弹窗
  // （玩家点"查看沙盘"——仍留游戏界面看最终状态；"返回标题屏"另走 handleExit）。
  // 瞬态 UI 路由态，不进 reducer/context（不持久化）。
  /**
   * 是否显示胜负终局弹窗（GameOverModal）。
   * advance/resolveDecision 结算后如 victoryState !== 'ongoing' 则 true。
   */
  showGameOver: boolean
  /** 关闭胜负终局弹窗（玩家点"查看沙盘"时调用；弹窗关闭但仍留游戏界面）。 */
  dismissGameOver: () => void

  // —— Bug A：推演即时弹窗（ResolutionProgressDialog）——
  // advance() 在等待 LLM 结算期间（phase==='resolution'）置 true，App.tsx 据此叠加
  // 全屏 ResolutionProgressDialog（深空蓝半透明 + 青光 + 扫描线 + 各 Agent 进度 +
  // 流式战报打字机）。结算完成 → phase 变 'briefing' → showResolutionProgress 自动清
  // （App.tsx useEffect 监听 phase 离开 resolution 时清）。
  // 瞬态 UI 路由态，不进 reducer/context（不持久化）。
  /**
   * 是否显示推演即时弹窗（ResolutionProgressDialog）。
   * advance() 进入 resolution 阶段置 true；phase 离开 resolution 自动清。
   */
  showResolutionProgress: boolean
  /** 设置推演即时弹窗激活态（advance 进 resolution 时 true；离开 resolution 时 false）。 */
  setShowResolutionProgress: (v: boolean) => void

  // —— T3-A：NPC 主动外交响应（NpcDiplomacyModal）——
  // advanceTurn 结算后若 world.pendingNpcRequests 非空，App 渲染 NpcDiplomacyModal。
  // 玩家选择 接受/拒绝/谈判 后调 respondNpcDiplomacy：
  // - accept ceasefire/reinforcement：发起方 faction 对玩家 trust +10（感恩/履约）。
  // - accept threat：发起方 faction 对玩家 trust 不变（玩家让步但 NPC 视为理所当然）。
  // - reject：发起方 faction 对玩家 trust -5（关系紧张）。
  // - negotiate：不改 trust，仅清空请求（玩家进入外交官对话 tab 自行交涉）。
  // 响应后清空 world.pendingNpcRequests（避免重复弹窗）+ best-effort 持久化。
  /**
   * 响应 NPC 主动外交请求（接受/拒绝/谈判）。
   *
   * @param request 当前处理的请求（来自 world.pendingNpcRequests[0]）
   * @param response 玩家响应类别（accept/reject/negotiate）
   */
  respondNpcDiplomacy: (
    request: DiplomaticRequest,
    response: 'accept' | 'reject' | 'negotiate',
  ) => void
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

  // 第 5 批：创建战役独立页默认关闭（标题屏态）
  creatorPageActive: false,

  // 第 3 批：沙盘悬浮 cellId 初始无（鼠标未进入网格）
  hoveredCellId: null,

  // Bug3 修复：对话记忆初始为空（store 持有，跨组件重挂载持久）
  // 第 2+3 批：dialoguesByRole 按角色分组；activeRoleId 默认 'chief'（首个 tab）。
  activeRoleId: 'chief',
  dialoguesByRole: {},
  // dialogues 为 chief 角色镜像（初始空，appendDialogueByRole 时同步更新）
  dialogues: [],

  // 第 2 批：流式对话/Agent 实时输出初始为空
  liveChat: null,
  agentLiveOutputs: {},

  // 命令候选初始无（store 持有，中右两栏共享）
  candidate: null,

  // 第 3 批：决策挂起句柄（初始无挂起）
  pendingDecisionHandle: null,

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
        pendingDecision: null,
        error: null,
      }
      const all = await persistenceService.listSaves()
      const saves = all.filter(isPlayerSaveId)
      // 第 5 批：新战役创建后标记显示开场参谋长简报弹窗。
      // 第 6 批：新战役开局重置胜负弹窗标志（避免上一局终局弹窗残留）。
      set({ context: ctx, saveId, saves, busy: false, showOpeningBriefing: true, showGameOver: false })
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
      // 视角 bug 修复：旧存档（v0.2.2 之前）world-state 无 playerFactionId 字段。
      // 兼容回填：旧存档从未 side swap，剧本默认 player 方即为玩家所选（否则早有 bug），
      // 故从 factions 中 side==='player' 的首个回填；回填后写回 world-state 持久化迁移。
      // best-effort：回填/写回失败不阻断载入（内存 world 已正确，下次推进会带字段落盘）。
      if (!world.playerFactionId || world.playerFactionId.length === 0) {
        const fallback = world.factions.find((f) => f.side === 'player')?.id ?? ''
        if (fallback.length > 0) {
          world.playerFactionId = fallback
          persistenceService.writeWorldState(saveId, world).catch((e) => {
            logger.warn('store/loadSave/migrate_failed', `旧存档 playerFactionId 迁移写回失败: ${String(e)}`, {
              scope: 'save', saveId,
            })
          })
        }
      }
      // 刷新恢复：从 world-state 重建 idle 上下文（持久化已完成，允许推进）
      const ctx: StateMachineContext = {
        game: { phase: 'idle', world },
        pendingOrders: [],
        lockedOrders: {},
        lastResolution: null,
        persisting: false,
        persistCompleted: true,
        pendingDecision: null,
        error: null,
      }
      // 第 5 批：载入旧存档不显示开场参谋长简报（仅新战役创建时弹）。
      // 第 6 批：若载入的存档已终局（victoryState !== 'ongoing'），弹出 GameOverModal
      // （玩家可看到终局战报 / 返回标题屏）；否则重置 showGameOver=false。
      const isGameOver =
        !!world.victoryState && world.victoryState !== 'ongoing'
      set({
        context: ctx,
        saveId,
        busy: false,
        showOpeningBriefing: false,
        showGameOver: isGameOver,
      })
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
      agentLiveOutputs: {},
    })
    // 流式战报开始（编排期间 director 增量写入 liveReport）
    set({ streamingReport: true })
    // Bug A：进入 resolution 阶段立即显示推演即时弹窗。
    // 即便 LLM 慢、Agent 进度未到，玩家也看到「导演部推演中...」弹窗（脉冲进度条），
    // 不会以为画面卡住。结算完成 phase→briefing 后由 App.tsx useEffect 清 false。
    set({ showResolutionProgress: true })
    try {
      // 多 Agent 结算器（带进度回调 + 流式战报；解锁时用 LLM 角色，否则 mock）
      const resolver = buildMultiAgentResolver(get)
      const result = await advanceTurn(ctx, {
        persistence: persistenceService,
        resolve: resolver,
      })
      // 第 3 批：若在 decision 阶段挂起，存挂起句柄并保持 busy（等玩家选择）。
      if (result.pausedAtDecision && result.decisionHandle) {
        set({
          context: result.context,
          busy: false,
          // 流式战报已完成（briefing 阶段已显示）；decision 阶段保持 streamingReport=false
          streamingReport: false,
          // Bug A：结算完成（即便挂起 decision），关闭推演即时弹窗。
          showResolutionProgress: false,
          cacheStats: llmService.getCacheStats(),
          degraded: result.context.lastResolution?.degraded ?? false,
          pendingDecisionHandle: result.decisionHandle,
        })
        // 第 6 批：即便挂起在 decision，FINISH_RESOLUTION 后已评估胜负。
        // 若已终局，仍弹出 GameOverModal（覆盖 decision，因为战役已结束）。
        const pausedWorld = result.context.game.world
        if (
          pausedWorld.victoryState &&
          pausedWorld.victoryState !== 'ongoing'
        ) {
          set({ showGameOver: true })
        }
        return
      }
      // 结算完成：回写缓存统计、降级标志、envelopes（供 Inspector）
      set({
        context: result.context,
        busy: false,
        streamingReport: false,
        // Bug A：结算完成，关闭推演即时弹窗。
        showResolutionProgress: false,
        cacheStats: llmService.getCacheStats(),
        degraded: result.context.lastResolution?.degraded ?? false,
        pendingDecisionHandle: null,
      })
      // 第 4 批：advanceTurn persist-gate 已落盘 world-state，触发"已保存"角标。
      // 不阻塞主流程（markSaved 内 setTimeout 自清除）。
      const completedWorld = result.context.game.world
      get().markSaved(completedWorld.turnIndex)
      // 第 4 批：每 5 回合额外写 snapshot 副本（额外保险，加速崩溃回放）。
      // 已有 persist 落盘，snapshot 作为冗余锚点；best-effort，失败只 warn。
      void writePeriodicSnapshot(completedWorld)
      // 第 6 批：结算后若战役终局（victoryState !== 'ongoing'）→ 弹出 GameOverModal。
      if (
        completedWorld.victoryState &&
        completedWorld.victoryState !== 'ongoing'
      ) {
        set({ showGameOver: true })
      }
    } catch (err) {
      set({ streamingReport: false, showResolutionProgress: false })
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

  // 第 3 批：解决战术决策（decision 阶段玩家选择后调用）
  async resolveDecision(optionId, overrides) {
    const ctx = get().context
    const handle = get().pendingDecisionHandle
    if (ctx === null || handle === null) {
      set({ userError: '无待解决的战术决策' })
      return
    }
    set({ busy: true, userError: null })
    try {
      // 1. dispatch RESOLVE_DECISION（纯函数 reducer，应用 overrides 到 world）
      const ok = get().dispatch({ type: 'RESOLVE_DECISION', optionId, overrides })
      if (!ok) {
        set({ busy: false })
        return
      }
      // dispatch 后 context 已更新（phase=persist，world 已应用 overrides）
      const resolvedCtx = get().context
      if (resolvedCtx === null) {
        set({ busy: false, userError: '决策解决后上下文丢失' })
        return
      }
      // 2. 调 resumeTurnAfterDecision 完成本回合（persist → idle → NEXT_TURN）
      const result = await resumeTurnAfterDecision(resolvedCtx, {
        persistence: persistenceService,
      }, handle, optionId, overrides)
      set({
        context: result.context,
        busy: false,
        pendingDecisionHandle: null,
      })
      // 第 4 批：决策解决后落盘完成，触发"已保存"角标 + 每 5 回合 snapshot。
      const decidedWorld = result.context.game.world
      get().markSaved(decidedWorld.turnIndex)
      void writePeriodicSnapshot(decidedWorld)
      // 第 6 批：若 advanceTurn 期间已判终局（FINISH_RESOLUTION 后 evaluateVictory），
      // 决策解决完成后弹出 GameOverModal。
      if (
        decidedWorld.victoryState &&
        decidedWorld.victoryState !== 'ongoing'
      ) {
        set({ showGameOver: true })
      }
    } catch (err) {
      // 落盘失败等：上下文可能已被部分推进，从 error.context 恢复（若存在）
      const banner = errorToBanner(err)
      set({ llmError: banner, cacheStats: llmService.getCacheStats() })
      const maybeCtx = (err as { context?: StateMachineContext }).context
      if (maybeCtx) {
        set({ context: maybeCtx, busy: false, userError: `决策解决失败：${String(err)}`, pendingDecisionHandle: null })
      } else {
        set({ busy: false, userError: `决策解决失败：${String(err)}`, pendingDecisionHandle: null })
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
      pendingDecision: null,
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
      agentLiveOutputs: {},
      // Bug A：清推演即时弹窗态（防御：即便 advance 未清，新回合也复位）。
      showResolutionProgress: false,
    })
  },

  setSelectedUnitId(unitId) {
    set({ selectedUnitId: unitId })
  },

  clearSelectedUnit() {
    set({ selectedUnitId: null })
  },

  // 第 5 批：创建战役独立页路由态切换
  setCreatorPageActive(active) {
    set({ creatorPageActive: active })
  },

  // 第 4 批：自动保存 UI 反馈。advance/resolveDecision 落盘成功后调 markSaved，
  // 置 showSavedIndicator=true（Header 角标"✓ 已保存"闪现），3s 后自动清除。
  lastSavedAt: null,
  showSavedIndicator: false,
  markSaved(turnIndex) {
    set({ showSavedIndicator: true, lastSavedAt: turnIndex })
    // 3 秒后自动清除角标（不阻塞主流程，setTimeout 失败只 console.warn）。
    // 多次连击 advance 会重叠多个 timer，但每次 set 都重置 showSavedIndicator=true，
    // 最晚的 timer 把它清掉即可，无累积副作用。
    window.setTimeout(() => {
      set({ showSavedIndicator: false })
    }, 3000)
  },
  clearSavedIndicator() {
    set({ showSavedIndicator: false })
  },

  // 第 5 批：开场参谋长简报弹窗（瞬态 UI 路由态）。
  // 初始 false（标题屏未开局）。markOpeningBriefing 由 createSave / 内置包开局 /
  // 导入 ZIP 开局调用（新战役才弹）；dismissOpeningBriefing 由 OpeningBriefing 按钮
  // 「开始指挥」调用。loadSave 不调 markOpeningBriefing（旧存档不弹）。
  showOpeningBriefing: false,
  markOpeningBriefing() {
    set({ showOpeningBriefing: true })
  },
  dismissOpeningBriefing() {
    set({ showOpeningBriefing: false })
  },

  // 第 6 批：胜负终局弹窗（瞬态 UI 路由态）。
  // 初始 false。advance/resolveDecision 结算后若 world.victoryState !== 'ongoing' 则 true。
  // dismissGameOver 由 GameOverModal「查看沙盘」按钮调用（关闭弹窗，仍留游戏界面）。
  showGameOver: false,
  dismissGameOver() {
    set({ showGameOver: false })
  },

  // Bug A：推演即时弹窗（瞬态 UI 路由态）。
  // 初始 false。advance() 进入 resolution 阶段（streamingReport:true 时）置 true，
  // 让 App.tsx 叠加 ResolutionProgressDialog（即便 LLM 慢、Agent 未回进度，玩家也看到弹窗）。
  // phase 离开 resolution（→ briefing/decision/idle）后由 App.tsx useEffect 清 false。
  showResolutionProgress: false,
  setShowResolutionProgress(v) {
    set({ showResolutionProgress: v })
  },

  // T3-A：响应 NPC 主动外交请求（NpcDiplomacyModal 玩家选择后调用）。
  // 修改 world.factions 的 trust 数值（发起方对玩家的信任度）+ 清空
  // pendingNpcRequests（避免重复弹窗）+ best-effort 持久化。
  respondNpcDiplomacy(request, response) {
    const ctx = get().context
    if (ctx === null) return
    const world = ctx.game.world
    // 信任度增量：accept ceasefire/reinforcement +10 / accept threat 0 / reject -5 / negotiate 0
    let trustDelta = 0
    if (response === 'accept') {
      // ceasefire/reinforcement：NPC 感恩玩家履约，trust+10；
      // threat：玩家让步但 NPC 视为理所当然（trust 不变，避免玩家被威胁反而获信任增益）。
      trustDelta = request.kind === 'threat' ? 0 : 10
    } else if (response === 'reject') {
      trustDelta = -5
    }
    // negotiate：不改 trust（玩家要求进一步谈判，关系暂不动）。

    // 修改发起方 faction 对玩家的 trust（npc.trust[playerId]）
    const playerId = world.playerFactionId
    const newFactions = world.factions.map((f) => {
      if (f.id !== request.fromFactionId) return f
      if (trustDelta === 0) return f
      const curTrust = f.trust[playerId] ?? 50
      const newTrust = Math.max(0, Math.min(100, curTrust + trustDelta))
      return { ...f, trust: { ...f.trust, [playerId]: newTrust } }
    })

    // 清空 pendingNpcRequests（玩家已响应）
    const newWorld: WorldState = {
      ...world,
      factions: newFactions,
      pendingNpcRequests: [],
    }
    const newCtx: StateMachineContext = {
      ...ctx,
      game: { ...ctx.game, world: newWorld },
    }
    set({ context: newCtx })

    // best-effort 持久化（不阻塞 UI；失败只 warn）
    const saveId = world.saveId
    persistenceService.writeWorldState(saveId, newWorld).catch((e) => {
      logger.warn('store/npc_diplomacy/persist_failed', `NPC 外交响应持久化失败: ${String(e)}`, {
        scope: 'save', saveId,
      })
    })
    logger.info('store/npc_diplomacy/respond', '玩家响应 NPC 外交请求', {
      scope: 'save', saveId,
      turn: world.turnIndex,
      kind: request.kind,
      fromFactionId: request.fromFactionId,
      response,
      trustDelta,
    })
  },

  // 第 3 批：沙盘 cell 悬浮 tooltip（SandboxRenderer move 模式回调驱动）
  setHoveredCellId(cellId) {
    // 性能：仅当值变化时 set（pointermove 高频，避免无谓 zustand 通知触发 CellTooltip 重渲染）
    if (get().hoveredCellId === cellId) return
    set({ hoveredCellId: cellId })
  },

  // 第 2+3 批：切换当前激活角色 tab（DialogueStream tab 点击）。
  // 切换时同步把 dialogues 派生镜像更新为新角色的历史（dialoguesByRole[roleId]），
  // 否则 useCommandDialogue 读 dialogues 会拿到旧角色历史（串台 bug）。
  setActiveRole(roleId) {
    if (get().activeRoleId === roleId) return
    set((s) => ({
      activeRoleId: roleId,
      dialogues: s.dialoguesByRole[roleId] ?? [],
    }))
  },

  // 第 2+3 批：追加一条对话到指定角色 tab 历史。
  // 自动补 entry.role 字段；若 roleId === activeRoleId（chief 默认激活），
  // 同时刷新 dialogues 派生镜像（向后兼容 useCommandDialogue 的 chief 历史读取）。
  appendDialogueByRole(roleId, entry) {
    const role = entry.role ?? roleId
    const enriched = { ...entry, role }
    set((s) => {
      const cur = s.dialoguesByRole[roleId] ?? []
      const next = [...cur, enriched]
      const trimmed =
        next.length > DIALOGUE_LIMIT ? next.slice(next.length - DIALOGUE_LIMIT) : next
      const byRole = { ...s.dialoguesByRole, [roleId]: trimmed }
      // dialogues 派生镜像：仅当当前激活 tab === roleId 时同步（chief 默认激活）。
      // 这样 useCommandDialogue 读 dialogues 始终拿到当前 tab 的历史，
      // 而 chief.chat 多轮上下文在切到 chief tab 时也正确。
      const dialogues = s.activeRoleId === roleId ? trimmed : s.dialogues
      return { dialoguesByRole: byRole, dialogues }
    })
  },

  // Bug3 修复：对话记忆 actions（store 持有，避免组件重挂载丢失）。
  // 第 2+3 批：appendDialogue 委托给 appendDialogueByRole('chief', ...)（兼容旧调用点）。
  appendDialogue(entry) {
    get().appendDialogueByRole('chief', entry)
  },

  clearDialogues() {
    set({ dialoguesByRole: {}, dialogues: [] })
  },

  // —— 第 2 批：流式对话/Agent 实时输出 actions ——
  setLiveChat(role) {
    set({ liveChat: { text: '', role } })
  },

  appendLiveChatDelta(delta) {
    set((s) => {
      if (s.liveChat === null) {
        // 防御：onDelta 在 setLiveChat 之前到达（不应发生），自动初始化为 chief。
        return { liveChat: { text: delta, role: 'chief' } }
      }
      return { liveChat: { text: s.liveChat.text + delta, role: s.liveChat.role } }
    })
  },

  clearLiveChat() {
    set({ liveChat: null })
  },

  setAgentLiveOutput(agentId, partial) {
    set((s) => {
      const next = { ...s.agentLiveOutputs }
      if (partial.length === 0) {
        delete next[agentId]
      } else {
        next[agentId] = partial
      }
      return { agentLiveOutputs: next }
    })
  },

  clearAgentLiveOutputs() {
    set({ agentLiveOutputs: {} })
  },

  // 命令候选 actions（store 持有，中右两栏共享，打通命令确认流程）
  setCandidate(c) {
    set({ candidate: c })
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

/**
 * 第 4 批：每 5 回合写一次 snapshot 副本（额外保险，加速崩溃回放锚点）。
 *
 * 触发条件：turnIndex % 5 === 0（第 0/5/10... 回合）。已有 advanceTurn persist-gate
 * 落盘 world-state.json，snapshot 作为冗余副本（snapshot.json），失败只 warn 不阻塞。
 * best-effort：异常吞掉记日志，绝不影响主推进流程。
 *
 * @param world 当前世界状态（已落盘后的）
 */
async function writePeriodicSnapshot(world: WorldState): Promise<void> {
  if (world.turnIndex % 5 !== 0) return
  try {
    const snap = createTurnSnapshot(world, 'persist')
    await writeSnapshot(world.saveId, snap)
    logger.info('store/snapshot/periodic', `第 ${world.turnIndex} 回合快照已写入`, {
      scope: 'save',
      saveId: world.saveId,
      turn: world.turnIndex,
    })
  } catch (err) {
    // 快照失败不阻断主流程（world-state.json 已是真相源兜底）
    logger.warn('store/snapshot/periodic_failed', `周期快照写入失败: ${String(err)}`, {
      scope: 'save',
      saveId: world.saveId,
      turn: world.turnIndex,
    })
  }
}

/**
 * 命令对话共享 hook（useCommandDialogue.ts）— UI 重构第 1 批「全对话为主」。
 *
 * 把原 CommandTerminal 的对话/命令/外交逻辑提取为共享 hook，供：
 * - DialogueStream（中栏）：气泡流 + 输入框
 * - CommandTerminal（右栏）：候选命令卡 / 外交卡 / 待锁队列 / 锁定按钮
 * 共享同一份对话历史（dialogues）与状态，避免中右两栏参谋长回复不一致。
 *
 * 逻辑与原 CommandTerminal 完全一致（不重写对话逻辑），仅从组件 useState 提取到 hook。
 *
 * 不 import @tauri-apps/api（UI 层）。gateway 唯一。
 *
 * @module layers/ui/terminal/useCommandDialogue
 */

import { useState, useCallback } from 'react'
import {
  useGameStore,
  buildLlmCallConfig,
  getCampaignRulesForScenario,
  type DialogueEntry,
} from '@/store/game-store'
import {
  chiefRole,
  createLlmChiefRole,
  classifyInput,
  type ChiefChatResult,
} from '@/layers/agents/roles/chief'
import {
  diplomatRole,
  createLlmDiplomatRole,
  type DiplomatChatResult,
} from '@/layers/agents/roles/diplomat'
import {
  playerCommanderRole,
  createLlmPlayerCommanderRole,
  type PlayerCommanderChatResult,
} from '@/layers/agents/roles/player-commander'
import type { AIRoleDef, DialogueTurn } from '@/types'
import { llmService } from '@/layers/application/services/llm-service'
import {
  submitOrder,
  lockOrders,
  buildEnvelope,
  canSubmitNow,
  canEnterHandshake,
} from '@/layers/application/orchestrator/handshake-flow'
import {
  resolveDiplomaticResponse,
  rollDiplomaticResponse,
  inferRequestKind,
  describeRequestKind,
  describeResponseType,
  responseColor,
  type DiplomaticRequest,
  type DiplomaticResponseType,
  type DiplomaticRequestResult,
} from '@/layers/domain/diplomacy-request'
import { inferStance } from '@/layers/domain/diplomacy'
import { commanderRole } from '@/layers/agents/roles/commander'
import { logger } from '@/utils/logger'
import type {
  ParseCommandResult,
  ParsedCommand,
  ActionEnvelope,
} from '@/types'

/** 传给 chief.chat 的最近 N 轮（避免 prompt 过长；store 已裁剪到 50 条上限） */
const CHIEF_HISTORY_TURNS = 8

/**
 * 第 2+3 批：角色 tab 描述（DialogueStream 顶部 tab 栏渲染用）。
 *
 * roleId 为 store.activeRoleId 的取值；type 决定色标（chief 青/diplomat 蓝/
 * commander 橙/director 紫/player 白）；label/responsibleUnits 供 tab 显示与
 * playerCommander.chat 注入。
 */
export interface PlayerRoleTab {
  /** 角色 id（'chief'/'diplomat'/'commander-xxx'） */
  roleId: string
  /** 角色类型（决定色标与对话路由） */
  type: 'chief' | 'diplomat' | 'commander' | 'director' | 'player'
  /** tab 显示名（如「参谋长」「外交官」「炮兵司令」） */
  label: string
  /** 该角色负责的单位 id 列表（commander 用；缺省=本方全部） */
  responsibleUnits?: readonly string[]
}

/**
 * 第 2+3 批：从 campaign rules.aiRoles 过滤出玩家侧角色，构造 tab 列表。
 *
 * 玩家侧角色定义：
 * - chief 永远是首个 tab（默认，无 AIRoleDef 也显示）。
 * - rules.aiRoles 中 factionId === playerFactionId 的角色（含 chief/diplomat/commander）。
 * - 去重：若 aiRoles 已有玩家方 chief，跳过默认 chief（避免重复 tab）。
 *
 * roleId 命名：
 * - chief → 'chief'
 * - diplomat → 'diplomat'
 * - commander → 'commander-' + aiRole.id 尾段（避免多 commander 冲突）
 *
 * 无 campaign rules（内置 m1-skeleton 等无 aiRoles）→ 仅默认 chief tab。
 */
function usePlayerRoleTabs(
  context: ReturnType<typeof useGameStore.getState>['context'],
): PlayerRoleTab[] {
  // 注：此函数虽名为 use*，但内部不调 hook（纯计算）；命名沿用 hook 习惯。
  // 直接读 store 顶部 import 的 getCampaignRulesForScenario。
  if (context === null) return [{ roleId: 'chief', type: 'chief', label: '参谋长' }]
  const world = context.game.world
  const playerFactionId = getPlayerFactionId(world)
  const rules = getCampaignRulesForScenario(world.scenarioId)
  const tabs: PlayerRoleTab[] = []
  const seenRoleIds = new Set<string>()
  let hasPlayerChief = false

  if (rules?.aiRoles) {
    for (const ar of rules.aiRoles) {
      // 玩家侧角色：factionId === playerFactionId（chief 类角色可能无 factionId，兜底玩家方）
      const isPlayerSide = ar.factionId === playerFactionId
      if (!isPlayerSide) continue
      const roleId = roleDefToRoleId(ar)
      if (seenRoleIds.has(roleId)) continue
      seenRoleIds.add(roleId)
      if (ar.type === 'chief') hasPlayerChief = true
      tabs.push({
        roleId,
        type: ar.type,
        label: roleDefLabel(ar),
        responsibleUnits: ar.responsibleUnits,
      })
    }
  }

  // 默认 chief tab：若 aiRoles 无玩家方 chief，补一个（保证总有参谋长 tab）。
  if (!hasPlayerChief) {
    tabs.unshift({ roleId: 'chief', type: 'chief', label: '参谋长' })
  }
  return tabs
}

/** AIRoleDef → roleId（chief/diplomat 原样；commander 加前缀避免多 commander 冲突）。 */
function roleDefToRoleId(ar: AIRoleDef): string {
  if (ar.type === 'chief') return 'chief'
  if (ar.type === 'diplomat') return 'diplomat'
  // commander：用 'commander-' + ar.id（ar.id 已唯一）
  return `commander-${ar.id}`
}

/** AIRoleDef → tab 显示名（优先 displayName，兜底 type 中文名）。 */
function roleDefLabel(ar: AIRoleDef): string {
  // 优先用战役包显式声明的 displayName（人名/职务短标签，如「法金汉」「皇太子」）。
  if (ar.displayName && ar.displayName.length > 0) return ar.displayName
  // 兜底：type 中文名（无 displayName 时，如内置 m1-skeleton 无 aiRoles）。
  const ROLE_TYPE_CN: Record<AIRoleDef['type'], string> = {
    chief: '参谋长',
    diplomat: '外交官',
    commander: '指挥官',
    director: '导演部',
  }
  return ROLE_TYPE_CN[ar.type]
}

/** 玩家方 commander tab 的职务称呼（playerCommander.chat title 用）。 */
function commanderTitle(roleDef: AIRoleDef | undefined): string | undefined {
  if (roleDef === undefined) return undefined
  return roleDefLabel(roleDef)
}

/** 按 scenarioId + playerFactionId + roleId 反查 AIRoleDef（commander 路由用）。 */
function findPlayerRoleDef(
  scenarioId: string,
  playerFactionId: string,
  roleId: string,
): AIRoleDef | undefined {
  const rules = getCampaignRulesForScenario(scenarioId)
  if (!rules?.aiRoles) return undefined
  for (const ar of rules.aiRoles) {
    if (ar.factionId !== playerFactionId) continue
    if (roleDefToRoleId(ar) === roleId) return ar
  }
  return undefined
}

/**
 * 命令对话共享 hook。
 *
 * 返回 DialogueStream 与 CommandTerminal 所需的全部状态与处理函数。
 */
export function useCommandDialogue(): {
  context: ReturnType<typeof useGameStore.getState>['context']
  busy: boolean
  phase: string
  canSubmit: boolean
  canEnter: boolean
  // 主对话/命令框
  draftCommand: string
  setDraftCommand: (v: string) => void
  parsing: boolean
  handleSubmit: () => Promise<void>
  dialogues: DialogueEntry[]
  // 第 2+3 批：角色 tab 多角色对话
  /** 当前激活角色 tab id（'chief'/'diplomat'/'commander-xxx'） */
  activeRoleId: string
  /** 切换角色 tab（DialogueStream tab 点击） */
  setActiveRole: (roleId: string) => void
  /** 按角色分组的对话历史（roleId → entries） */
  dialoguesByRole: Record<string, DialogueEntry[]>
  /** 玩家侧可用角色列表（供 DialogueStream 渲染 tab；含 chief 默认 + rules.aiRoles 过滤） */
  playerRoles: PlayerRoleTab[]
  // 候选命令
  candidate: ParseCommandResult | null
  handleConfirm: () => void
  handleModify: () => void
  // 外交
  draftDiplomatic: string
  setDraftDiplomatic: (v: string) => void
  diplomatic: DiplomaticRequestResult | null
  setDiplomatic: (v: DiplomaticRequestResult | null) => void
  diplomaticPending: boolean
  handleDiplomatic: () => Promise<void>
  // 锁定
  handleLock: () => void
  // 错误
  userError: string | null
  clearError: () => void
} {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const dispatch = useGameStore((s) => s.dispatch)
  const clearError = useGameStore((s) => s.clearError)
  const userError = useGameStore((s) => s.userError)
  // Bug3 修复：dialogues 从 store 读写（不再 useState），跨组件重挂载/跨回合持久。
  // 第 2+3 批：dialogues 为当前 activeRoleId 的派生镜像；多角色历史经
  // dialoguesByRole + appendDialogueByRole 分组管理。
  const dialogues = useGameStore((s) => s.dialogues)
  const dialoguesByRole = useGameStore((s) => s.dialoguesByRole)
  const activeRoleId = useGameStore((s) => s.activeRoleId)
  const setActiveRole = useGameStore((s) => s.setActiveRole)
  const appendDialogueByRole = useGameStore((s) => s.appendDialogueByRole)
  // 命令候选从 store 读写（中栏解析 → 右栏确认，跨组件共享；原 useState 导致右栏永远 null）。
  const candidate = useGameStore((s) => s.candidate)
  const setCandidate = useGameStore((s) => s.setCandidate)
  // 第 2 批：流式对话（liveChat）—— chief.chat 逐字回写 store，DialogueStream 订阅渲染打字机。
  const setLiveChat = useGameStore((s) => s.setLiveChat)
  const appendLiveChatDelta = useGameStore((s) => s.appendLiveChatDelta)
  const clearLiveChat = useGameStore((s) => s.clearLiveChat)

  const [draftCommand, setDraftCommand] = useState('')
  const [draftDiplomatic, setDraftDiplomatic] = useState('')
  const [parsing, setParsing] = useState(false)
  const [diplomatic, setDiplomatic] = useState<DiplomaticRequestResult | null>(null)
  const [diplomaticPending, setDiplomaticPending] = useState(false)

  const phase = context?.game.phase ?? 'idle'
  const canSubmit = context !== null && canSubmitNow(context) && !busy
  const canEnter = context !== null && canEnterHandshake(context)

  // 第 2+3 批：计算玩家侧可对话角色 tab 列表（chief 默认 + rules.aiRoles 过滤）。
  // DialogueStream 顶部 tab 栏据此渲染。玩家侧 = factionId === playerFactionId 或 type==='chief'。
  const playerRoles = usePlayerRoleTabs(context)

  /** 统一提交入口：classifyInput 路由「命令」/「对话」 */
  const handleSubmit = useCallback(async (): Promise<void> => {
    const input = draftCommand.trim()
    if (input.length === 0 || context === null) return
    const kind = classifyInput(input)
    if (kind === 'command') {
      await handleParse(input)
    } else {
      await handleChat(input)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCommand, context])

  /** 参谋长解析命令（planning 时先进入 handshake） */
  const handleParse = useCallback(async (input: string): Promise<void> => {
    if (context === null) return
    setParsing(true)
    try {
      let cur = context
      if (cur.game.phase === 'planning') {
        const ok = dispatch({ type: 'ENTER_HANDSHAKE' })
        if (!ok) return
        cur = useGameStore.getState().context!
      }
      logger.info('ui/command/parse', '参谋解析命令', {
        scope: 'save',
        saveId: cur.game.world.saveId,
        turn: cur.game.world.turnIndex,
        useLlm: buildLlmCallConfig() !== null,
      })
      const llmConfig = buildLlmCallConfig()
      const role = llmConfig !== null
        ? createLlmChiefRole(llmService, llmConfig)
        : chiefRole
      const result = await role.parseCommand(input, {
        world: cur.game.world,
        playerFactionId: getPlayerFactionId(cur.game.world),
      })
      setCandidate(result)
    } finally {
      setParsing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, dispatch])

  /**
   * 多角色对话（第 2+3 批：按 activeRoleId 路由）。
   *
   * - 'chief' → chief.chat（既有参谋长对话）。
   * - 'diplomat' → diplomat.chat（外交官谈判，外交请求并入对话）。
   * - 'commander-*' → playerCommander.chat（玩家方某指挥官，按 responsibleUnits）。
   *
   * 各角色独立历史（dialoguesByRole[activeRoleId]），切换 tab 不影响其他角色。
   * 流式打字机统一走 store liveChat（setLiveChat 用角色名作 role 标识）。
   */
  const handleChat = useCallback(async (input: string): Promise<void> => {
    if (context === null) return
    const roleId = useGameStore.getState().activeRoleId
    setParsing(true)
    // 第 2+3 批：setLiveChat 用 roleId 作 role 标识（DialogueStream 据此显示对应角色名）。
    setLiveChat(roleId)
    try {
      const cur = useGameStore.getState().context
      if (cur === null) return
      const world = cur.game.world
      const playerFactionId = getPlayerFactionId(world)
      const llmConfig = buildLlmCallConfig()
      // 当前 tab 的对话历史（按 roleId 取，跨回合持久）
      const history = dialoguesToHistory(dialoguesByRole[roleId] ?? [], CHIEF_HISTORY_TURNS)
      const onDelta = (partial: string) => appendLiveChatDelta(partial)

      let reply: { text: string; source: 'mock' | 'llm' }
      if (roleId === 'chief') {
        const role = llmConfig !== null ? createLlmChiefRole(llmService, llmConfig) : chiefRole
        logger.info('ui/command/chat', '参谋对话', {
          scope: 'save', saveId: world.saveId, turn: world.turnIndex, useLlm: llmConfig !== null,
        })
        const r: ChiefChatResult = await role.chat(
          input, { world, playerFactionId }, history, onDelta,
        )
        reply = r
      } else if (roleId === 'diplomat') {
        const role = llmConfig !== null ? createLlmDiplomatRole(llmService, llmConfig) : diplomatRole
        logger.info('ui/command/chat', '外交官对话', {
          scope: 'save', saveId: world.saveId, turn: world.turnIndex, useLlm: llmConfig !== null,
        })
        const r: DiplomatChatResult = await role.chat(
          input, { world, playerFactionId }, history, onDelta,
        )
        reply = r
      } else if (roleId.startsWith('commander-')) {
        // 玩家方指挥官 tab：从 campaign rules.aiRoles 找该角色定义（responsibleUnits/title）
        const roleDef = findPlayerRoleDef(world.scenarioId, playerFactionId, roleId)
        const role = llmConfig !== null ? createLlmPlayerCommanderRole(llmService, llmConfig) : playerCommanderRole
        logger.info('ui/command/chat', '指挥官对话', {
          scope: 'save', saveId: world.saveId, turn: world.turnIndex,
          useLlm: llmConfig !== null, roleId,
        })
        const r: PlayerCommanderChatResult = await role.chat(
          input,
          {
            world,
            playerFactionId,
            responsibleUnits: roleDef?.responsibleUnits,
            title: commanderTitle(roleDef),
          },
          history,
          onDelta,
        )
        reply = r
      } else {
        // 未知 roleId：回退 chief（防御）
        const role = llmConfig !== null ? createLlmChiefRole(llmService, llmConfig) : chiefRole
        const r: ChiefChatResult = await role.chat(
          input, { world, playerFactionId }, history, onDelta,
        )
        reply = r
      }
      // 流式完成：清 liveChat，把完整回复入对应角色历史（转正常气泡）。
      clearLiveChat()
      appendDialogueByRole(roleId, { input, role: roleId, reply })
      setDraftCommand('')
    } finally {
      // 防御：异常路径也清 liveChat，避免「正在输入」气泡卡住。
      clearLiveChat()
      setParsing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, dialoguesByRole, appendDialogueByRole, setLiveChat, appendLiveChatDelta, clearLiveChat])

  /** 玩家确认候选命令 → 入 pendingOrders */
  const handleConfirm = useCallback((): void => {
    if (context === null || candidate === null || candidate.kind !== 'parsed') return
    const cur = useGameStore.getState().context
    if (cur === null) return
    const sequence = cur.pendingOrders.length
    const envelope = buildEnvelope({
      turn: cur.game.world.turnIndex,
      faction: getPlayerFactionId(cur.game.world),
      intent: candidate.intent,
      payload: parsedCommandToPayload(candidate),
      sequence,
    })
    try {
      const next = submitOrder(cur, envelope)
      useGameStore.setState({ context: next, userError: null })
      setCandidate(null)
      setDraftCommand('')
    } catch (err) {
      useGameStore.setState({ userError: (err as Error).message })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, candidate, setCandidate])

  /** 玩家选择修改 → 清除候选回到输入 */
  const handleModify = useCallback((): void => {
    setCandidate(null)
  }, [setCandidate])

  /** 锁定所有命令进入结算 */
  const handleLock = useCallback((): void => {
    if (context === null) return
    const cur = useGameStore.getState().context
    if (cur === null) return
    try {
      const next = lockOrders(cur)
      useGameStore.setState({ context: next, userError: null })
      logger.info('ui/command/lock', '玩家锁定命令进入结算', {
        scope: 'save',
        saveId: cur.game.world.saveId,
        turn: cur.game.world.turnIndex,
        orderCount: cur.pendingOrders.length,
      })
    } catch (err) {
      useGameStore.setState({ userError: (err as Error).message })
    }
  }, [context])

  /** 提交外交请求 → 盟友统帅响应 → 信任度变化 */
  const handleDiplomatic = useCallback(async (): Promise<void> => {
    if (context === null) return
    const input = draftDiplomatic.trim()
    if (input.length === 0) return
    const cur = useGameStore.getState().context
    if (cur === null) return
    const world = cur.game.world
    // 视角 bug 修复：优先用 world.playerFactionId 定位玩家阵营对象，fallback side==='player'。
    const playerFaction =
      world.playerFactionId && world.playerFactionId.length > 0
        ? world.factions.find((f) => f.id === world.playerFactionId)
        : world.factions.find((f) => f.side === 'player')
    // 第 5 批多阵营支撑：优先用 faction.relations[playerFactionId]==='allied' 找盟友；
    // 缺失 relations 时回退 side==='ally'（旧存档兼容）。
    const allyFaction = playerFaction
      ? world.factions.find(
          (f) =>
            f.id !== playerFaction.id &&
            (f.relations?.[playerFaction.id] === 'allied' || f.side === 'ally'),
        )
      : undefined
    if (playerFaction === undefined || allyFaction === undefined) {
      useGameStore.setState({ userError: '未找到玩家或盟友阵营，无法发起外交请求' })
      return
    }
    setDiplomaticPending(true)
    try {
      const request: DiplomaticRequest = {
        turn: world.turnIndex,
        fromFactionId: playerFaction.id,
        toFactionId: allyFaction.id,
        kind: inferRequestKind(input),
        text: input,
      }
      const commanderResult = await commanderRole.resolve({
        world,
        factionId: allyFaction.id,
        turn: world.turnIndex,
        scenarioSeed: world.scenarioSeed,
      })
      const disobeying = commanderResult.disobeying
      const trustValue = allyFaction.trust[playerFaction.id] ?? 50
      const seedHash = hashSeed(world.scenarioSeed, world.turnIndex, input)
      const rand = (seedHash % 1000) / 1000
      const responseType: DiplomaticResponseType = rollDiplomaticResponse(trustValue, rand, disobeying)
      const message = buildAllyMessage(responseType, disobeying, request.kind, trustValue)
      const trustRecord = {
        trust: trustValue,
        stance: inferStance(trustValue),
        honoredCount: 0,
        brokenCount: 0,
        lastChangeTurn: 0,
      } as DiplomaticRequestResult['trustAfter']
      const result = resolveDiplomaticResponse(trustRecord, {
        request,
        type: responseType,
        message,
        disobeying,
      })
      setDiplomatic(result)
      setDraftDiplomatic('')
    } finally {
      setDiplomaticPending(false)
    }
  }, [context, draftDiplomatic])

  return {
    context,
    busy,
    phase,
    canSubmit,
    canEnter,
    draftCommand,
    setDraftCommand,
    parsing,
    handleSubmit,
    dialogues,
    activeRoleId,
    setActiveRole,
    dialoguesByRole,
    playerRoles,
    candidate,
    handleConfirm,
    handleModify,
    draftDiplomatic,
    setDraftDiplomatic,
    diplomatic,
    setDiplomatic,
    diplomaticPending,
    handleDiplomatic,
    handleLock,
    userError,
    clearError,
  }
}

// ============================================================================
// 纯辅助函数（从 CommandTerminal 迁移，保持一致）
// ============================================================================

/**
 * 获取玩家阵营 id（视角 bug 修复）。
 *
 * 优先读 world.playerFactionId（v0.2.2+ 权威字段），fallback factions 中 side==='player'
 * （旧存档/未注入时兜底；side swap 后此 fallback 亦正确）。
 */
function getPlayerFactionId(
  world: { playerFactionId?: string; factions: Array<{ id: string; side: string }> },
): string {
  if (world.playerFactionId && world.playerFactionId.length > 0) return world.playerFactionId
  const player = world.factions.find((f) => f.side === 'player')
  return player?.id ?? ''
}

/** UI 对话历史 → chief.chat history 参数 */
function dialoguesToHistory(
  dialogues: ReadonlyArray<{ input: string; reply: ChiefChatResult }>,
  turns = 8,
): DialogueTurn[] {
  const recent = dialogues.slice(-turns)
  const out: DialogueTurn[] = []
  for (const d of recent) {
    out.push({ role: 'player', text: d.input })
    out.push({ role: 'chief', text: d.reply.text })
  }
  return out
}

/** ParsedCommand → Worker payload */
function parsedCommandToPayload(cmd: ParsedCommand): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (cmd.targetUnitIds.length > 0) base.unitId = cmd.targetUnitIds[0]
  if (cmd.targetCoord !== undefined) base.target = cmd.targetCoord
  if (cmd.targetUnitId !== undefined) base.targetUnitId = cmd.targetUnitId
  if (cmd.nodeId !== undefined) base.nodeId = cmd.nodeId
  base.kind = cmd.intent
  return base
}

/** 确定性种子哈希（FNV-1a 变体） */
function hashSeed(scenarioSeed: string, turn: number, text: string): number {
  let h = 2166136261
  const str = `${scenarioSeed}:${turn}:${text}`
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/** 构造盟友统帅的响应文本 */
function buildAllyMessage(
  type: DiplomaticResponseType,
  disobeying: boolean,
  kind: DiplomaticRequest['kind'],
  trustValue: number,
): string {
  const kindName = describeRequestKind(kind)
  switch (type) {
    case 'accept':
      return `同意你的${kindName}请求。我们会全力配合。`
    case 'reject':
      if (trustValue < 30) return `恕难答应${kindName}请求。考虑到我们的关系，这并非易事。`
      return `这次${kindName}请求我们无法配合，请谅解。`
    case 'flake':
      return disobeying
        ? `虽答应${kindName}请求，但前线抗命，未能如期履约。`
        : `答应${kindName}请求，但后勤受阻，未能兑现承诺。`
    default:
      return ''
  }
}

/** 格式化信封为人类可读（CommandTerminal 队列展示用） */
export function formatEnvelope(env: ActionEnvelope): string {
  const INTENT_NAMES: Record<string, string> = {
    move: '移动', attack: '攻击', capture_node: '占领', hold: '固守', recon: '侦察',
  }
  const unit = (env.payload.unitId as string | undefined) ?? '?'
  const target = env.payload.target as { col: number; row: number } | undefined
  const targetUnit = env.payload.targetUnitId as string | undefined
  const node = env.payload.nodeId as string | undefined
  const intentName = INTENT_NAMES[env.intent] ?? env.intent
  const targetStr = target ? `(${target.col},${target.row})` : (targetUnit ?? node ?? '')
  return `${intentName}：${unit} → ${targetStr}`
}

// describeRequestKind/describeResponseType/responseColor 由 CommandTerminal 子组件直接
// 从 diplomacy-request 引入复用（此处 re-export 仅保持 import 链一致）。
export {
  describeRequestKind,
  describeResponseType,
  responseColor,
}

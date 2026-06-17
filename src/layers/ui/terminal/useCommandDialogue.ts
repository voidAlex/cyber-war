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
import { useGameStore, buildLlmCallConfig, type DialogueEntry } from '@/store/game-store'
import {
  chiefRole,
  createLlmChiefRole,
  classifyInput,
  type ChiefChatResult,
} from '@/layers/agents/roles/chief'
import type { DialogueTurn } from '@/types'
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
  const dialogues = useGameStore((s) => s.dialogues)
  const appendDialogue = useGameStore((s) => s.appendDialogue)
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

  /** 参谋长对话（询问态势/问候/闲聊；第 2 批：流式打字机） */
  const handleChat = useCallback(async (input: string): Promise<void> => {
    if (context === null) return
    setParsing(true)
    // 第 2 批：开始流式对话，DialogueStream 据此渲染「正在输入」气泡（逐字）。
    setLiveChat('chief')
    try {
      const cur = useGameStore.getState().context
      if (cur === null) return
      const llmConfig = buildLlmCallConfig()
      const role = llmConfig !== null
        ? createLlmChiefRole(llmService, llmConfig)
        : chiefRole
      logger.info('ui/command/chat', '参谋对话', {
        scope: 'save',
        saveId: cur.game.world.saveId,
        turn: cur.game.world.turnIndex,
        useLlm: llmConfig !== null,
      })
      const reply = await role.chat(
        input,
        { world: cur.game.world, playerFactionId: getPlayerFactionId(cur.game.world) },
        // Bug3 修复：history 从 store.dialogues 取（跨回合持久，不再因组件重挂载断裂）
        dialoguesToHistory(dialogues, CHIEF_HISTORY_TURNS),
        // 第 2 批：onDelta 把每段 partial 累加到 store liveChat.text（打字机）。
        // 仅 UI 副作用，不影响 prompt 结构/缓存前缀。
        (partial) => appendLiveChatDelta(partial),
      )
      // 流式完成：先清 liveChat（「正在输入」气泡消失），再把完整回复入历史（转正常气泡）。
      clearLiveChat()
      // Bug3 修复：追加到 store（带上限 50 条，store 内裁剪），跨组件共享
      appendDialogue({ input, reply })
      setDraftCommand('')
    } finally {
      // 防御：异常路径也清 liveChat，避免「正在输入」气泡卡住。
      clearLiveChat()
      setParsing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, dialogues, appendDialogue, setLiveChat, appendLiveChatDelta, clearLiveChat])

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

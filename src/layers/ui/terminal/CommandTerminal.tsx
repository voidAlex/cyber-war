/**
 * 命令握手终端（CommandTerminal.tsx）— M2 命令握手 UI。
 *
 * 对应 TDD §3.2 命令握手协议：
 * - 自然语言输入框 → 调 chief.parseCommand → 显示候选命令卡片
 *   （意图 + 单位 + 目标，沙盘自动画虚线预演 via pendingOrders）
 * - 玩家「确认执行」(CONFIRM_HANDSHAKE→入 pendingOrders) 或「修改」
 *
 * 阶段守卫（重写计划关键防坑「命令提交无视阶段」）：
 * - 仅 planning/handshake 阶段可输入（guard.canSubmitOrder）。
 * - 其他阶段输入框禁用并提示当前阶段。
 * - UI + reducer 双保险（submitOrder 内部再守卫一次）。
 *
 * 候选命令入 pendingOrders 后，沙盘 Sandbox 自动显示虚线（M2-B 已支持订阅）。
 *
 * @module layers/ui/terminal/CommandTerminal
 */

import { useState, useCallback, useRef, type JSX } from 'react'
import { useGameStore, buildLlmCallConfig } from '@/store/game-store'
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
  ClarifyRequest,
  ActionEnvelope,
} from '@/types'

/** 意图中文显示名 */
const INTENT_NAMES: Record<string, string> = {
  move: '移动',
  attack: '攻击',
  capture_node: '占领',
  hold: '固守',
}

/**
 * 命令握手终端组件。
 */
export default function CommandTerminal(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const dispatch = useGameStore((s) => s.dispatch)
  const clearError = useGameStore((s) => s.clearError)
  const userError = useGameStore((s) => s.userError)

  // === 拆分后的独立 state（重写计划 B：对话/命令/外交不互相干扰） ===
  // 对话/命令主输入框（问候/询问/命令统一入口，classifyInput 路由）
  const [draftCommand, setDraftCommand] = useState('')
  // 外交请求独立输入框（不与主框共用 draft，避免打字互相覆盖）
  const [draftDiplomatic, setDraftDiplomatic] = useState('')

  const [candidate, setCandidate] = useState<ParseCommandResult | null>(null)
  const [parsing, setParsing] = useState(false)

  // 参谋长对话历史（chat 模式，区别于候选命令卡片）。
  // 玩家对话/询问 → 参谋自然语言回复，渲染为青光对话气泡。
  // 最近一条在最下；保留最近 20 条（重写计划 B：>6 拉长到 20，多轮上下文更连贯）。
  // 同时用作 chief.chat 的 history 参数（转 DialogueTurn[]）让参谋有记忆。
  const [dialogues, setDialogues] = useState<Array<{ input: string; reply: ChiefChatResult }>>([])

  /**
   * dialogues 的 ref 镜像（重写计划 B：多轮上下文）。
   *
   * 为什么用 ref：handleChat 调 chief.chat 时需取**最新** dialogues 作 history。
   * 但 handleChat 经 handleSubmit 调用，handleSubmit 的 useCallback 依赖若含 dialogues，
   * 会导致每次对话后整条链路重建（且 handleSubmit 在 handleChat 前声明会有 TDZ）。
   * 用 ref 让 handleChat 闭包始终读到最新 dialogues，无需把 dialogues 列入依赖。
   *
   * 每次 dialogues 变化时由下面的 effect 同步到 ref。
   */
  const dialoguesRef = useRef(dialogues)
  dialoguesRef.current = dialogues // 每次渲染同步（ref 赋值是幂等的，无副作用）

  // 外交请求流程状态（M4-B，独立于主对话流）
  const [diplomatic, setDiplomatic] = useState<DiplomaticRequestResult | null>(null)
  const [diplomaticPending, setDiplomaticPending] = useState(false)

  /** 对话历史上限（重写计划 B：>6 拉长到 20，多轮上下文更连贯） */
  const DIALOGUE_HISTORY_LIMIT = 20
  /** 传给 chief.chat 的最近 N 轮（避免 prompt 过长，取最近 8 轮 = 16 条 player+chief） */
  const CHIEF_HISTORY_TURNS = 8

  const phase = context?.game.phase ?? 'idle'

  // 是否允许输入命令（planning/handshake）
  const canSubmit = context !== null && canSubmitNow(context) && !busy
  // 是否可进入握手（planning 阶段首次输入时自动触发）
  const canEnter = context !== null && canEnterHandshake(context)

  /**
   * 统一提交入口（主对话/命令框）：先 classifyInput 判断「命令」还是「对话」再路由。
   *
   * - 命令（含移动/攻击/占领/固守等意图词且非疑问句式）→ handleParse（parseCommand 流程）。
   * - 对话/询问（问候、问态势、闲聊、带疑问标志）→ handleChat（参谋自然语言回复）。
   *
   * 这样玩家输入"你好"不会被误解析成命令（修复真机问题1）。
   * "怎么样需要移动吗"含疑问标志 → chat（重写计划 B classifyInput 优化）。
   */
  const handleSubmit = useCallback(async (): Promise<void> => {
    const input = draftCommand.trim()
    if (input.length === 0 || context === null) return
    const kind = classifyInput(input)
    if (kind === 'command') {
      await handleParse(input)
    } else {
      await handleChat(input)
    }
    // handleChat/handleParse 经 dialoguesRef 取最新对话历史（ref 模式），
    // 故此处无需把它们列入依赖——多轮上下文 history 仍正确传递（重写计划 B）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCommand, context])

  /**
   * 调参谋长解析命令（planning 时先进入 handshake）。
   *
   * 解锁状态下用真 LLM chief（createLlmChiefRole + 真 LLM 调用，失败回退 mock），
   * 否则用 mock chief（规则解析，离线/降级可玩）。llmService 与 advance 同源（模块单例），
   * config 由 buildLlmCallConfig() 从会话取明文 apiKey（即用即抛，不进 store）。
   */
  const handleParse = useCallback(async (input: string): Promise<void> => {
    if (context === null) return

    setParsing(true)
    try {
      // planning 阶段首次解析时进入 handshake（参谋反问/预演阶段）
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
      // 角色选择：解锁用真 LLM chief，未解锁用 mock（与 advance 同源决策）
      // createLlmChiefRole 内部 LLM 失败自动回退 mock，绝不让游戏卡死。
      const llmConfig = buildLlmCallConfig()
      const role = llmConfig !== null
        ? createLlmChiefRole(llmService, llmConfig)
        : chiefRole

      const result = await role.parseCommand(input, {
        world: cur.game.world,
        playerFactionId: getPlayerFactionId(cur.game.world),
      })
      setCandidate(result)
      logger.debug('ui/command/parse_done', `解析结果: ${result.kind}`, {
        scope: 'save',
        saveId: cur.game.world.saveId,
        resultKind: result.kind,
      })
    } finally {
      setParsing(false)
    }
  }, [context, dispatch])

  /**
   * 参谋长对话（询问态势/问候/闲聊）。
   *
   * 任何阶段都可对话（不强制 planning/handshake）——对话不改变游戏状态。
   * 真 LLM 解锁用 createLlmChiefRole.chat（参谋人格回复，失败回退 mock 模板），
   * 未解锁用 mock chief.chat（纯模板，基于真实 world 状态，不伪造命令）。
   * 回复追加到 dialogues 历史渲染为青光对话气泡。
   */
  const handleChat = useCallback(async (input: string): Promise<void> => {
    if (context === null) return

    setParsing(true)
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
        {
          world: cur.game.world,
          playerFactionId: getPlayerFactionId(cur.game.world),
        },
        // 多轮上下文：把最近 N 轮 dialogues 转为 DialogueTurn[] 传给 chief.chat。
        // 取最近 CHIEF_HISTORY_TURNS 轮（每轮含 player+chief），让参谋有记忆。
        // 用 ref 取最新 dialogues（避免 useCallback 依赖链重建 + TDZ）。
        dialoguesToHistory(dialoguesRef.current, CHIEF_HISTORY_TURNS),
      )

      // 追加到对话历史（保留最近 DIALOGUE_HISTORY_LIMIT 条避免无限增长）。
      // 重写计划 B：上限从 6 拉长到 20，多轮上下文更连贯。
      setDialogues((prev) => {
        const next = [...prev, { input, reply }]
        return next.length > DIALOGUE_HISTORY_LIMIT
          ? next.slice(next.length - DIALOGUE_HISTORY_LIMIT)
          : next
      })
      setDraftCommand('')
    } finally {
      setParsing(false)
    }
  }, [context])

  /** 玩家确认候选命令 → 入 pendingOrders（沙盘自动显示虚线）。 */
  const handleConfirm = useCallback((): void => {
    if (context === null || candidate === null || candidate.kind !== 'parsed') return
    const cur = useGameStore.getState().context
    if (cur === null) return

    // 构造 ActionEnvelope 入队（sequence 在 chief 段，按已有 pendingOrders 数递增）
    const sequence = cur.pendingOrders.length // chief 段 0+
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
  }, [context, candidate])

  /** 玩家选择修改 → 清除候选回到输入。 */
  const handleModify = useCallback((): void => {
    setCandidate(null)
  }, [])

  /** 锁定所有命令进入结算（handshake → locked → 后续 advanceTurn）。 */
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

  /**
   * 提交外交请求 → 盟友统帅（commander Agent）响应 → 信任度变化（M4-B）。
   *
   * 流程：
   * 1. 推断请求类别（inferRequestKind）+ 定位盟友阵营。
   * 2. 调 commander Agent.resolve 取 disobeying（盟友统帅抗命态）。
   * 3. rollDiplomaticResponse：按盟友对玩家信任度 + 抗命决定 accept/reject/flake。
   * 4. resolveDiplomaticResponse：结算信任度变化（履约 +8 / 毁约 -20）。
   * 5. UI 展示请求卡片 + 响应结果 + 信任度变化。
   *
   * 信任度数值落盘由后续 orchestrator 统一处理（本流程仅展示 + 写 lastResolution 提示）。
   */
  const handleDiplomatic = useCallback(async (): Promise<void> => {
    if (context === null) return
    const input = draftDiplomatic.trim()
    if (input.length === 0) return
    const cur = useGameStore.getState().context
    if (cur === null) return

    const world = cur.game.world
    const playerFaction = world.factions.find((f) => f.side === 'player')
    const allyFaction = world.factions.find((f) => f.side === 'ally')
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

      // 调盟友统帅 Agent 取 disobeying（信任度概率的输入之一）
      const commanderResult = await commanderRole.resolve({
        world,
        factionId: allyFaction.id,
        turn: world.turnIndex,
        scenarioSeed: world.scenarioSeed,
      })
      const disobeying = commanderResult.disobeying

      // 盟友对玩家的信任度（决定拒绝率/flake 概率）
      const trustValue = allyFaction.trust[playerFaction.id] ?? 50
      // 确定性随机：基于场景种子 + 回合（可回放）
      const seedHash = hashSeed(world.scenarioSeed, world.turnIndex, input)
      const rand = (seedHash % 1000) / 1000
      const responseType: DiplomaticResponseType = rollDiplomaticResponse(
        trustValue,
        rand,
        disobeying,
      )

      // 构造盟友统帅响应文本（mock 规则文本，LLM 接入后可替换）
      const message = buildAllyMessage(responseType, disobeying, request.kind, trustValue)

      // 构造 DiplomacyTrust 摘要（从 faction.trust 数值还原）
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

  // 未加载存档
  if (context === null) {
    return (
      <section className="panel command-terminal">
        <h2 className="panel__title">命令终端</h2>
        <p className="command-terminal__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const inputEnabled = canSubmit
  const phaseHint = getPhaseHint(phase)
  // 对话/询问不受阶段守卫限制（不改变游戏状态）：命令需要 planning/handshake。
  // 输入框在「命令」阶段被守卫；对话可在任何阶段。这里给一个宽松策略：
  // 输入框始终可用（除非 busy），由 handleSubmit 内部按 classify 路由——
  // 命令走 handleParse（内部守卫 planning/handshake），对话走 handleChat（无守卫）。
  // 但若处于 locked/resolution/briefing/persist 等阶段，命令会被守卫，此时仍可对话。

  return (
    <section className="panel command-terminal">
      <h2 className="panel__title">命令终端</h2>

      <div className="command-terminal__input-row">
        <input
          type="text"
          className="command-terminal__input"
          placeholder={inputEnabled ? '如：第一装甲师移动到 C3 或「你好」' : phaseHint}
          value={draftCommand}
          onChange={(e) => setDraftCommand(e.target.value)}
          disabled={busy || parsing}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !parsing && !busy && draftCommand.trim().length > 0) {
              void handleSubmit()
            }
          }}
        />
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy || parsing || draftCommand.trim().length === 0}
        >
          {parsing ? '处理中…' : '发送'}
        </button>
      </div>

      {!inputEnabled && !busy && (
        <p className="command-terminal__phase-hint">
          当前阶段「{phaseHint}」——无法下达命令，但仍可与参谋对话（问候/询问态势）。
        </p>
      )}

      {/* 参谋长对话历史（chat 模式回复，青光气泡） */}
      {dialogues.length > 0 && (
        <div className="command-terminal__dialogues">
          {dialogues.map((d, i) => (
            <DialogueBubble key={i} input={d.input} reply={d.reply} />
          ))}
        </div>
      )}

      {candidate !== null && candidate.kind === 'clarify' && (
        <ClarifyCard request={candidate} onDismiss={() => setCandidate(null)} />
      )}

      {candidate !== null && candidate.kind === 'parsed' && (
        <CandidateCard
          command={candidate}
          onConfirm={handleConfirm}
          onModify={handleModify}
        />
      )}

      {/* 外交请求流程（M4-B）：玩家向盟友统帅发起请求，任何阶段可用。
          独立 draft（draftDiplomatic），不与主对话/命令框共用，避免打字互相覆盖。 */}
      <div className="command-terminal__diplomacy">
        <h3>外交请求</h3>
        <div className="command-terminal__input-row">
          <input
            type="text"
            className="command-terminal__input"
            placeholder="如：请求盟友空中支援 / 增援 / 情报共享"
            value={draftDiplomatic}
            onChange={(e) => setDraftDiplomatic(e.target.value)}
            disabled={diplomaticPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !diplomaticPending && draftDiplomatic.trim().length > 0) {
                void handleDiplomatic()
              }
            }}
          />
          <button
            type="button"
            onClick={() => void handleDiplomatic()}
            disabled={diplomaticPending || draftDiplomatic.trim().length === 0 || context === null}
          >
            {diplomaticPending ? '请求中…' : '发起外交'}
          </button>
        </div>
        {diplomatic !== null && (
          <DiplomaticCard result={diplomatic} onDismiss={() => setDiplomatic(null)} />
        )}
      </div>

      {/* 已入队命令列表 */}
      {context.pendingOrders.length > 0 && (
        <div className="command-terminal__queue">
          <h3>待锁定命令（{context.pendingOrders.length}）</h3>
          <ul>
            {context.pendingOrders.map((env) => (
              <li key={env.sequence}>{formatEnvelope(env)}</li>
            ))}
          </ul>
          <button
            type="button"
            className="command-terminal__lock"
            onClick={handleLock}
            disabled={busy || phase !== 'handshake'}
          >
            锁定命令并准备结算
          </button>
        </div>
      )}

      {userError !== null && (
        <div className="command-terminal__error" role="alert">
          <span>{userError}</span>
          <button type="button" onClick={clearError}>知道了</button>
        </div>
      )}

      <p className="command-terminal__hint">
        {canEnter && '提示：输入命令后会自动进入握手确认阶段。'}
      </p>
    </section>
  )
}

/** lockOrders 经 orchestrator dispatch（保持 import 简洁，运行时无开销）。 */

/**
 * 获取玩家阵营 id（首个 side=player 的 faction）。
 */
function getPlayerFactionId(world: { factions: Array<{ id: string; side: string }> }): string {
  const player = world.factions.find((f) => f.side === 'player')
  return player?.id ?? ''
}

/**
 * 把 UI 对话历史（dialogues 数组）转为 chief.chat 的 history 参数（DialogueTurn[]）。
 *
 * 每条 UI dialogue 含玩家问话 + 参谋回复，拆成两条 DialogueTurn（player + chief）。
 * 取最近 N 轮（每轮 = player + chief 两条），避免 prompt 过长。
 *
 * 重写计划 B：多轮上下文记忆——参谋能援引上文（如"刚才你问的杜奥蒙堡"）。
 *
 * @param dialogues UI 对话历史数组（每条含 input + reply）
 * @param turns 取最近 N 轮（默认 8 轮 = 16 条 player+chief）
 * @returns DialogueTurn[]（player/chief 交替）
 */
function dialoguesToHistory(
  dialogues: ReadonlyArray<{ input: string; reply: ChiefChatResult }>,
  turns = 8,
): DialogueTurn[] {
  // 取最近 turns 轮
  const recent = dialogues.slice(-turns)
  const out: DialogueTurn[] = []
  for (const d of recent) {
    out.push({ role: 'player', text: d.input })
    out.push({ role: 'chief', text: d.reply.text })
  }
  return out
}

/**
 * ParsedCommand → Worker payload（与 worker normalizeIntent 字段约定对齐）。
 *
 * move: { unitId, target: {col,row} }
 * attack: { unitId, targetUnitId }
 * capture_node: { unitId, nodeId }
 * hold: { unitId }（不结算移动/交战）
 */
function parsedCommandToPayload(cmd: ParsedCommand): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (cmd.targetUnitIds.length > 0) {
    base.unitId = cmd.targetUnitIds[0]
  }
  if (cmd.targetCoord !== undefined) {
    base.target = cmd.targetCoord
  }
  if (cmd.targetUnitId !== undefined) {
    base.targetUnitId = cmd.targetUnitId
  }
  if (cmd.nodeId !== undefined) {
    base.nodeId = cmd.nodeId
  }
  base.kind = cmd.intent
  return base
}

/** 阶段提示文案 */
function getPhaseHint(phase: string): string {
  const names: Record<string, string> = {
    idle: '空闲',
    planning: '规划',
    handshake: '握手确认',
    locked: '已锁定',
    resolution: '结算中',
    briefing: '战报',
    persist: '持久化',
  }
  return names[phase] ?? phase
}

/** 格式化信封为人类可读 */
function formatEnvelope(env: ActionEnvelope): string {
  const unit = (env.payload.unitId as string | undefined) ?? '?'
  const target = env.payload.target as { col: number; row: number } | undefined
  const targetUnit = env.payload.targetUnitId as string | undefined
  const node = env.payload.nodeId as string | undefined
  const intentName = INTENT_NAMES[env.intent] ?? env.intent
  const targetStr = target ? `(${target.col},${target.row})` : (targetUnit ?? node ?? '')
  return `${intentName}：${unit} → ${targetStr}`
}

// ============================================================================
// 子组件
// ============================================================================

/**
 * 外交请求结果卡片（M4-B）。
 *
 * 展示：请求类别 + 玩家文本 → 盟友统帅响应（accept/reject/flake）+ 信任度变化提示。
 */
function DiplomaticCard({
  result,
  onDismiss,
}: {
  result: DiplomaticRequestResult
  onDismiss: () => void
}): JSX.Element {
  const { response, trustAfter, delta, defectionRisk } = result
  const color = responseColor(response.type)
  const deltaText = delta > 0 ? `+${delta}` : `${delta}`
  const kindName = describeRequestKind(response.request.kind)
  return (
    <div
      className="command-terminal__diplomatic-card"
      role="status"
      style={{ borderColor: color }}
    >
      <div className="command-terminal__diplomatic-header">
        <strong>{kindName}</strong>
        <span style={{ color }}>{describeResponseType(response.type)}</span>
      </div>
      <p className="command-terminal__diplomatic-request">
        「{response.request.text}」
      </p>
      <p className="command-terminal__diplomatic-message">{response.message}</p>
      <div className="command-terminal__diplomatic-trust">
        <span>信任度</span>
        {/* 信任度 delta 色用设计 token（去硬编码 Material 色）：
            上升绿 / 下降红 / 持平灰 */}
        <strong style={{ color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
          {deltaText}
        </strong>
        <span>→ {trustAfter.trust}</span>
        {defectionRisk && (
          <span className="command-terminal__diplomatic-warn">（倒戈风险）</span>
        )}
      </div>
      <button type="button" onClick={onDismiss}>知道了</button>
    </div>
  )
}

/** 候选命令卡片（玩家确认/修改） */
function CandidateCard({
  command,
  onConfirm,
  onModify,
}: {
  command: ParsedCommand
  onConfirm: () => void
  onModify: () => void
}): JSX.Element {
  return (
    <div className="command-terminal__candidate" role="status">
      <div className="command-terminal__candidate-header">
        <strong>候选命令</strong>
        <span className={`command-terminal__intent command-terminal__intent--${command.intent}`}>
          {INTENT_NAMES[command.intent] ?? command.intent}
        </span>
      </div>
      <p className="command-terminal__summary">{command.summary}</p>
      <dl className="command-terminal__details">
        <div><dt>单位</dt><dd>{command.targetUnitIds.join('、')}</dd></div>
        {command.targetCoord !== undefined && (
          <div><dt>目标格</dt><dd>({command.targetCoord.col},{command.targetCoord.row})</dd></div>
        )}
        {command.targetUnitId !== undefined && (
          <div><dt>目标单位</dt><dd>{command.targetUnitId}</dd></div>
        )}
        {command.nodeId !== undefined && (
          <div><dt>节点</dt><dd>{command.nodeId}</dd></div>
        )}
      </dl>
      <div className="command-terminal__candidate-actions">
        <button type="button" onClick={onConfirm} className="command-terminal__confirm">
          确认执行
        </button>
        <button type="button" onClick={onModify}>修改</button>
      </div>
    </div>
  )
}

/** 需澄清卡片（解析失败/模糊，不伪造数据） */
function ClarifyCard({
  request,
  onDismiss,
}: {
  request: ClarifyRequest
  onDismiss: () => void
}): JSX.Element {
  return (
    <div className="command-terminal__clarify" role="alert">
      <strong>需要澄清</strong>
      <p>{request.reason}</p>
      {request.suggestions.length > 0 && (
        <ul>
          {request.suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onDismiss}>重新输入</button>
    </div>
  )
}

/**
 * 确定性种子哈希（FNV-1a 变体），用于外交响应的确定性随机源。
 *
 * 同一 (scenarioSeed, turn, text) 永远产出同一 rand → 可回放。
 */
function hashSeed(scenarioSeed: string, turn: number, text: string): number {
  let h = 2166136261
  const str = `${scenarioSeed}:${turn}:${text}`
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * 构造盟友统帅的响应文本（mock 规则文本，LLM 接入后可替换）。
 *
 * 绝不伪造承诺外的事实——文本仅描述响应类别与请求类别。
 */
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
      if (trustValue < 30) {
        return `恕难答应${kindName}请求。考虑到我们的关系，这并非易事。`
      }
      return `这次${kindName}请求我们无法配合，请谅解。`
    case 'flake':
      return disobeying
        ? `虽答应${kindName}请求，但前线抗命，未能如期履约。`
        : `答应${kindName}请求，但后勤受阻，未能兑现承诺。`
    default:
      return ''
  }
}

/**
 * 参谋长对话气泡（chat 模式回复）。
 *
 * 区别于候选命令卡片：对话气泡是参谋的自然语言回复（青光样式），
 * 不触发命令入队。展示玩家问话 + 参谋回复 + 来源标记（LLM/mock）。
 */
function DialogueBubble({
  input,
  reply,
}: {
  input: string
  reply: ChiefChatResult
}): JSX.Element {
  return (
    <div className="command-terminal__dialogue" role="status">
      <p className="command-terminal__dialogue-input">
        <span className="command-terminal__dialogue-speaker">指挥官</span>
        「{input}」
      </p>
      <div className="command-terminal__dialogue-reply">
        <span className="command-terminal__dialogue-speaker command-terminal__dialogue-speaker--chief">
          参谋长
        </span>
        <p className="command-terminal__dialogue-text">{reply.text}</p>
        <span className="command-terminal__dialogue-source">
          {reply.source === 'llm' ? 'LLM' : '离线模板'}
        </span>
      </div>
    </div>
  )
}

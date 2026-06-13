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

import { useState, useCallback, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { chiefRole } from '@/layers/agents/roles/chief'
import {
  submitOrder,
  lockOrders,
  buildEnvelope,
  canSubmitNow,
  canEnterHandshake,
} from '@/layers/application/orchestrator/handshake-flow'
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

  const [draft, setDraft] = useState('')
  const [candidate, setCandidate] = useState<ParseCommandResult | null>(null)
  const [parsing, setParsing] = useState(false)

  const phase = context?.game.phase ?? 'idle'

  // 是否允许输入命令（planning/handshake）
  const canSubmit = context !== null && canSubmitNow(context) && !busy
  // 是否可进入握手（planning 阶段首次输入时自动触发）
  const canEnter = context !== null && canEnterHandshake(context)

  /** 调参谋长解析命令（planning 时先进入 handshake）。 */
  const handleParse = useCallback(async (): Promise<void> => {
    if (context === null) return
    const input = draft.trim()
    if (input.length === 0) return

    setParsing(true)
    try {
      // planning 阶段首次解析时进入 handshake（参谋反问/预演阶段）
      let cur = context
      if (cur.game.phase === 'planning') {
        const ok = dispatch({ type: 'ENTER_HANDSHAKE' })
        if (!ok) return
        cur = useGameStore.getState().context!
      }

      // 调参谋长 mock 解析（基于真实世界状态校验目标）
      const result = await chiefRole.parseCommand(input, {
        world: cur.game.world,
        playerFactionId: getPlayerFactionId(cur.game.world),
      })
      setCandidate(result)
    } finally {
      setParsing(false)
    }
  }, [context, draft, dispatch])

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
      setDraft('')
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
    } catch (err) {
      useGameStore.setState({ userError: (err as Error).message })
    }
  }, [context])

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

  return (
    <section className="panel command-terminal">
      <h2 className="panel__title">命令终端</h2>

      <div className="command-terminal__input-row">
        <input
          type="text"
          className="command-terminal__input"
          placeholder={inputEnabled ? '如：第一装甲师移动到 C3' : phaseHint}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!inputEnabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && inputEnabled && !parsing) {
              void handleParse()
            }
          }}
        />
        <button
          type="button"
          onClick={() => void handleParse()}
          disabled={!inputEnabled || parsing || draft.trim().length === 0}
        >
          {parsing ? '解析中…' : '参谋解析'}
        </button>
      </div>

      {!inputEnabled && (
        <p className="command-terminal__phase-hint">当前阶段「{phaseHint}」，无法输入命令</p>
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
        <span className="command-terminal__intent">{INTENT_NAMES[command.intent] ?? command.intent}</span>
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

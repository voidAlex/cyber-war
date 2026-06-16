/**
 * 命令管理面板（CommandTerminal.tsx）— UI 重构第 1 批「全对话为主」右栏。
 *
 * 重构（第 1 批）：原 CommandTerminal 拆分为两部分——
 * - 中栏 DialogueStream：对话气泡流 + 主输入框（命令/对话统一入口）。
 * - 本组件（右栏）：候选命令卡 / 外交请求卡 / 待锁命令队列 / 锁定按钮。
 *
 * 逻辑经 useCommandDialogue 与 DialogueStream 共享（同一份对话历史 + 命令候选），
 * 不重写对话逻辑。本组件聚焦「命令确认/锁定」与「外交请求」交互。
 *
 * 对应 TDD §3.2 命令握手协议：候选命令卡（意图+单位+目标）→ 确认入队 → 锁定结算。
 *
 * @module layers/ui/terminal/CommandTerminal
 */

import { type JSX } from 'react'
import { useCommandDialogue, formatEnvelope } from './useCommandDialogue'
import type {
  ParsedCommand,
  ClarifyRequest,
} from '@/types'
import {
  describeRequestKind,
  describeResponseType,
  responseColor,
  type DiplomaticRequestResult,
} from '@/layers/domain/diplomacy-request'

/** 意图中文显示名 */
const INTENT_NAMES: Record<string, string> = {
  move: '移动',
  attack: '攻击',
  capture_node: '占领',
  hold: '固守',
  recon: '侦察',
}

/** phase 中文提示 */
const PHASE_NAMES: Record<string, string> = {
  idle: '空闲',
  planning: '规划',
  handshake: '握手确认',
  locked: '已锁定',
  resolution: '结算中',
  briefing: '战报',
  persist: '持久化',
  decision: '战术决策',
}

/**
 * 命令管理面板组件（右栏）。
 *
 * 渲染候选命令卡 / 外交请求 / 待锁队列；不渲染对话气泡与主输入框（已移至中栏 DialogueStream）。
 */
export default function CommandTerminal(): JSX.Element {
  const {
    context,
    busy,
    phase,
    candidate,
    handleConfirm,
    handleModify,
    draftDiplomatic,
    setDraftDiplomatic,
    handleDiplomatic,
    diplomatic,
    setDiplomatic,
    diplomaticPending,
    handleLock,
  } = useCommandDialogue()

  // 未加载存档
  if (context === null) {
    return (
      <section className="panel command-terminal">
        <h2 className="panel__title">命令</h2>
        <p className="command-terminal__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const phaseHint = PHASE_NAMES[phase] ?? phase
  const hasCandidate = candidate !== null
  const hasQueue = context.pendingOrders.length > 0

  return (
    <section className="panel command-terminal">
      <h2 className="panel__title">命令 · {phaseHint}</h2>

      {/* 候选命令卡 / 需澄清（玩家确认/修改） */}
      {candidate !== null && candidate.kind === 'clarify' && (
        <ClarifyCard request={candidate} onDismiss={handleModify} />
      )}
      {candidate !== null && candidate.kind === 'parsed' && (
        <CandidateCard command={candidate} onConfirm={handleConfirm} onModify={handleModify} />
      )}

      {/* 外交请求流程：独立 draft，不与主对话/命令框共用 */}
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

      {/* 已入队命令列表 + 锁定 */}
      {hasQueue && (
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

      {!hasCandidate && !hasQueue && (
        <p className="command-terminal__hint">
          在中栏输入命令或与参谋对话。候选命令将显示在此处确认。
        </p>
      )}
    </section>
  )
}

// ============================================================================
// 子组件（与原 CommandTerminal 保持一致，逻辑未重写）
// ============================================================================

/**
 * 外交请求结果卡片。
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
      <p className="command-terminal__diplomatic-request">「{response.request.text}」</p>
      <p className="command-terminal__diplomatic-message">{response.message}</p>
      <div className="command-terminal__diplomatic-trust">
        <span>信任度</span>
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

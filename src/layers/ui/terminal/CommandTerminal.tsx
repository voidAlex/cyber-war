/**
 * 命令管理面板（CommandTerminal.tsx）— UI 重构第 1 批「全对话为主」右栏。
 *
 * 重构（第 1 批）：原 CommandTerminal 拆分为两部分——
 * - 中栏 DialogueStream：对话气泡流 + 主输入框（命令/对话统一入口）。
 * - 本组件（右栏）：候选命令卡 / 待锁命令队列 / 锁定按钮。
 *
 * 逻辑经 useCommandDialogue 与 DialogueStream 共享（同一份对话历史 + 命令候选），
 * 不重写对话逻辑。本组件聚焦「命令确认/锁定」交互。
 *
 * Bug D 修复（2026-06）：删除右栏独立外交请求框（draftDiplomatic/handleDiplomatic/
 * DiplomaticCard），与「外交并入 diplomat tab」的对话路径冲突。
 * 外交请求现统一走中栏 diplomat tab 对话（DialogueStream 已有 diplomat 路径 +
 * NpcDiplomacyModal 处理 NPC 主动外交）。本组件不再渲染外交输入框/结果卡。
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
 * 渲染候选命令卡 / 待锁队列；不渲染对话气泡与主输入框（已移至中栏 DialogueStream）。
 * Bug D：不再渲染外交请求框（已并入 diplomat tab）。
 */
export default function CommandTerminal(): JSX.Element {
  const {
    context,
    busy,
    phase,
    candidate,
    handleConfirm,
    handleModify,
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
// 子组件（Bug D：已删除 DiplomaticCard 外交结果卡——外交请求并入 diplomat tab）
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

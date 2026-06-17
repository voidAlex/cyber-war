/**
 * 战术决策面板（DecisionHistoryPanel.tsx）— UI 扩展第 1 批「后勤/决策」。
 *
 * 职责（对应重写计划第 1 批「战术决策面板」）：
 * - 当前待决策：读 context.pendingDecision（如非 null → 显示决策摘要 + 选项卡片预览，
 *   玩家实际选择在 DecisionPanel 浮层完成；本面板仅只读预览）。
 * - 历史决策：从 event-log 异步读 kind:'adjudication' && source:'director' &&
 *   payload.kind:'override' 的事件（导演部终裁覆写，含战术决策后果），
 *   按回合倒序列出：回合 + 被覆写字段 + before→after + reason。
 *   优先展示 reason 含「决策/战术」关键词的（战术决策后果通常带此标注）。
 * - 无历史 → "暂无战术决策记录"。
 *
 * 数据源（复用现有，不新增数据结构）：
 * - store.context.pendingDecision（当前待决策，TacticalDecision | null）
 * - event-log.jsonl 经 readEventLog（persistence 层，经 gateway 异步读）
 *
 * 事件结构（agent-action.ts + director.ts overridesToDirectorActions）：
 *   { kind:'adjudication', source:'director', payload:{ kind:'override', field, before, after, reason }, text }
 * 注意：payload 无 decisionId 字段（决策后果以 override 形态落盘），故识别靠
 * payload.kind==='override' + reason 文本关键词。
 *
 * 异步读取模式：useEffect + readEventLog（参考 EventLogPanel），saveId/turnIndex
 * 变化时刷新；gateway 未就绪静默清空（不阻断 UI）。
 *
 * 不 import @tauri-apps/api（UI 层纯展示，readEventLog 内部经 gateway）。
 *
 * @module layers/ui/DecisionHistoryPanel
 */

import { useEffect, useState, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { readEventLog } from '@/layers/persistence/event-log'
import type { AgentAction } from '@/types'

/** 事件日志读取上限（历史决策通常稀疏，500 条够覆盖整局）。 */
const EVENT_LOG_LIMIT = 500

/** 历史决策行（从 director override 事件派生）。 */
interface HistoryRow {
  /** 事件 id（React key） */
  key: string
  /** 所属回合 */
  turn: number
  /** 被覆写字段（如 units.xxx.strength，UI 原样展示不解析） */
  field: string
  /** 覆写前值 */
  before: string
  /** 覆写后值 */
  after: string
  /** 后果说明（reason） */
  reason: string
  /** 是否战术决策类（reason 含关键词） */
  isTactical: boolean
}

/** 关键词：reason 含其一即视为战术决策后果（优先展示）。 */
const TACTICAL_KEYWORDS = ['战术决策', '决策', '战术', '抉择']

/**
 * 格式化 override 值：数字显示原值，其它显示 JSON 摘要。
 *
 * 与 DecisionPanel.formatValue 同语义（保持一致的人类可读输出）。
 */
function formatValue(v: unknown): string {
  if (typeof v === 'number') return String(v)
  if (v === null || v === undefined) return '—'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 从 event-log 派生历史决策行。
 *
 * 筛选 kind:'adjudication' && source:'director' && payload.kind==='override'，
 * 按 turn 降序、isTactical 优先排序。
 */
function deriveHistory(events: AgentAction[]): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (const evt of events) {
    if (evt.kind !== 'adjudication') continue
    if (evt.source !== 'director') continue
    const payload = evt.payload as { kind?: unknown; field?: unknown; before?: unknown; after?: unknown; reason?: unknown }
    if (payload.kind !== 'override') continue
    const field = typeof payload.field === 'string' ? payload.field : '(unknown)'
    const reason = typeof payload.reason === 'string' ? payload.reason : ''
    const isTactical = TACTICAL_KEYWORDS.some((kw) => reason.includes(kw))
    rows.push({
      key: evt.id,
      turn: evt.turn,
      field,
      before: formatValue(payload.before),
      after: formatValue(payload.after),
      reason,
      isTactical,
    })
  }
  // 回合降序；战术决策类在前
  rows.sort((a, b) => {
    if (a.isTactical !== b.isTactical) return a.isTactical ? -1 : 1
    return b.turn - a.turn
  })
  return rows
}

/**
 * 战术决策历史面板组件。
 *
 * - 当前待决策：context.pendingDecision 非空时顶部显示预览卡片（只读，不在此处选择）。
 * - 历史：useEffect 异步读 event-log → deriveHistory → 列表展示。
 * - 空态：无历史 → "暂无战术决策记录"。
 */
export default function DecisionHistoryPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const saveId = useGameStore((s) => s.saveId)

  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)

  // 异步拉取 event-log → 派生历史决策行（saveId/turn 变化时刷新）。
  // 参考 EventLogPanel 的 cancelled 守卫模式（避免异步回调 setState 到已卸载组件）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (saveId === null) {
        if (!cancelled) setHistory([])
        return
      }
      if (!cancelled) setLoading(true)
      try {
        const events = await readEventLog(saveId, 0, EVENT_LOG_LIMIT)
        if (!cancelled) setHistory(deriveHistory(events))
      } catch {
        // gateway 未就绪/无日志文件：静默清空（不阻断 UI）
        if (!cancelled) setHistory([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [saveId, context?.game.world.turnIndex])

  // 未加载存档
  if (context === null) {
    return (
      <section className="panel decisions-panel">
        <h2 className="panel__title">战术决策</h2>
        <p className="decisions-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const pending = context.pendingDecision

  return (
    <section className="panel decisions-panel">
      <h2 className="panel__title">战术决策</h2>

      {/* —— 当前待决策预览（只读；玩家在 DecisionPanel 浮层实际选择）—— */}
      {pending ? (
        <div className="decisions-panel__pending">
          <div className="decisions-panel__pending-head">
            <span className="decisions-panel__pending-turn">第 {pending.turn + 1} 天</span>
            <span className="decisions-panel__pending-badge">待决策</span>
          </div>
          <h3 className="decisions-panel__pending-label">{pending.label}</h3>
          <p className="decisions-panel__pending-desc">{pending.description}</p>
          <ul className="decisions-panel__pending-options">
            {pending.options.map((opt) => (
              <li key={opt.id} className="decisions-panel__pending-option">
                <span className="decisions-panel__pending-option-label">{opt.label}</span>
                <span className="decisions-panel__pending-option-desc">{opt.description}</span>
              </li>
            ))}
          </ul>
          <p className="decisions-panel__pending-hint">
            请在弹出的决策面板中选择以继续本回合。
          </p>
        </div>
      ) : (
        <p className="decisions-panel__muted">当前无待解决的战术决策。</p>
      )}

      {/* —— 历史决策列表 —— */}
      <div className="decisions-panel__section">
        <h3 className="decisions-panel__section-title">历史决策</h3>
        {loading ? (
          <p className="decisions-panel__muted">加载中…</p>
        ) : history.length === 0 ? (
          <p className="decisions-panel__empty">暂无战术决策记录。</p>
        ) : (
          <ul className="decisions-panel__history">
            {history.map((row) => (
              <li
                key={row.key}
                className={
                  'decisions-panel__history-row' +
                  (row.isTactical ? ' decisions-panel__history-row--tactical' : '')
                }
              >
                <div className="decisions-panel__history-head">
                  <span className="decisions-panel__history-turn">T{row.turn}</span>
                  <span className="decisions-panel__history-field">{row.field}</span>
                </div>
                <div className="decisions-panel__history-delta">
                  <span className="decisions-panel__history-before">{row.before}</span>
                  <span className="decisions-panel__history-arrow">→</span>
                  <span className="decisions-panel__history-after">{row.after}</span>
                </div>
                {row.reason.length > 0 && (
                  <p className="decisions-panel__history-reason">{row.reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

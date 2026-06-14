/**
 * 战报面板（BriefingPanel.tsx）— M3 增强版（流式战报 + Agent 进度）。
 *
 * 职责（对应重写计划 M3 范围#3 + 「真流式战报 TTFT<200ms」）：
 * - resolution 阶段：进度条 + 各 Agent 实时状态（参谋长/战区司令/敌方统帅/导演部），
 *   读 store.agentProgressById。
 * - director 战报**真流式**：读 store.liveReport（边出边显示，由 orchestrator
 *   onReportChunk 追加；M3 由 turn-resolution 透传到 director 的 streamTextWithDeltas）。
 * - briefing 阶段：完整战报（store.liveReport 完成态 或 context.lastResolution）
 *   + 战损摘要 + 胜负 + 降级提示。
 *
 * 「继续」→ ENTER_PERSIST（briefing → persist）。
 *
 * @module layers/ui/briefing/BriefingPanel
 */

import { type JSX } from 'react'
import { useGameStore, type AgentProgressEntry } from '@/store/game-store'
import { isActionAllowed } from '@/layers/application/state-machine'
import { AlertTriangle } from '@/layers/ui/icons'
import type { ResolutionSummary } from '@/types'

/** Agent 角色中文显示名 */
const ROLE_LABELS: Record<string, string> = {
  chief: '参谋长',
  theater: '战区司令',
  commander: '敌方统帅',
  director: '导演部',
}

/** Agent 状态中文显示名 */
const STATUS_LABELS: Record<AgentProgressEntry['status'], string> = {
  thinking: '思考中',
  running: '执行中',
  adjudicating: '裁定中',
  done: '已完成',
  failed: '失败',
}

/**
 * 战报面板组件。
 */
export default function BriefingPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const dispatch = useGameStore((s) => s.dispatch)
  const agentProgressById = useGameStore((s) => s.agentProgressById)
  const liveReport = useGameStore((s) => s.liveReport)
  const streamingReport = useGameStore((s) => s.streamingReport)
  const degraded = useGameStore((s) => s.degraded)

  if (context === null) {
    return (
      <section className="panel briefing-panel">
        <h2 className="panel__title">战报</h2>
        <p className="briefing-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const phase = context.game.phase
  const resolution = context.lastResolution

  // resolution 阶段：显示 Agent 进度 + 流式战报直播
  if (phase === 'resolution') {
    return (
      <section className="panel briefing-panel">
        <h2 className="panel__title">结算中…</h2>
        <AgentProgressList entries={Object.values(agentProgressById)} />
        {(streamingReport || liveReport.length > 0) && (
          <div className="briefing-panel__live-report">
            <h3>战报直播{streamingReport && <span className="briefing-panel__streaming-dot">●</span>}</h3>
            <pre className="briefing-panel__text">{liveReport || '（导演部正在生成战报…）'}</pre>
          </div>
        )}
      </section>
    )
  }

  // 非 briefing 阶段：占位提示当前阶段
  if (phase !== 'briefing' || resolution === null) {
    return (
      <section className="panel briefing-panel">
        <h2 className="panel__title">战报</h2>
        <p className="briefing-panel__empty">
          {phase === 'briefing'
            ? '暂无上回合战报数据。'
            : `当前阶段「${phaseName(phase)}」，战报将在结算后展示。`}
        </p>
      </section>
    )
  }

  const canContinue = isActionAllowed(phase, 'ENTER_PERSIST') && !busy
  // briefing 阶段优先用流式累积的完整战报（若 orchestrator 已填），否则用 lastResolution
  const reportText = liveReport || resolution.reportText

  return (
    <section className="panel briefing-panel">
      <h2 className="panel__title">战报 — 第 {resolution.turn + 1} 天</h2>

      {(resolution.degraded || degraded) && (
        <p className="briefing-panel__degraded" role="alert">
          <AlertTriangle size={14} aria-hidden /> 本回合为降级结算（规则引擎兜底，无叙事润色）
        </p>
      )}

      <div className="briefing-panel__report">
        <pre className="briefing-panel__text">{reportText || '（本日无战事）'}</pre>
      </div>

      <CasualtySummary casualties={resolution.casualties} world={context.game.world} />
      <ObjectiveChanges changes={resolution.objectiveChanges} world={context.game.world} />

      <div className="briefing-panel__actions">
        <button
          type="button"
          onClick={() => dispatch({ type: 'ENTER_PERSIST' })}
          disabled={!canContinue}
        >
          继续进入持久化
        </button>
      </div>
    </section>
  )
}

/** Agent 进度列表子组件 */
function AgentProgressList({ entries }: { entries: AgentProgressEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return <p className="briefing-panel__progress-empty">正在初始化结算…</p>
  }
  // 按 role 固定顺序展示（chief/theater/commander/director）
  const order = { chief: 0, theater: 1, commander: 2, director: 3 }
  const sorted = [...entries].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9))
  const doneCount = sorted.filter((e) => e.status === 'done').length
  const pct = sorted.length === 0 ? 0 : Math.round((doneCount / sorted.length) * 100)

  return (
    <div className="briefing-panel__progress">
      <div className="briefing-panel__progress-bar">
        <div className="briefing-panel__progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="briefing-panel__agent-list">
        {sorted.map((e) => (
          <li
            key={e.agentId}
            className={`briefing-panel__agent briefing-panel__agent--${e.status}`}
          >
            <span className="briefing-panel__agent-role">
              {ROLE_LABELS[e.role] ?? e.role}
            </span>
            <span className="briefing-panel__agent-status">
              {STATUS_LABELS[e.status]}
              {e.status === 'failed' && e.error ? `：${e.error}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 战损摘要子组件 */
function CasualtySummary({
  casualties,
  world,
}: {
  casualties: ResolutionSummary['casualties']
  world: { factions: Array<{ id: string; name: string }> }
}): JSX.Element {
  const entries = Object.entries(casualties)
  if (entries.length === 0) {
    return <p className="briefing-panel__no-casualty">本日无战损记录。</p>
  }
  return (
    <div className="briefing-panel__casualties">
      <h3>战损摘要</h3>
      <table>
        <thead>
          <tr><th>阵营</th><th>人员损失</th><th>战损</th></tr>
        </thead>
        <tbody>
          {entries.map(([factionId, loss]) => {
            const faction = world.factions.find((f) => f.id === factionId)
            return (
              <tr key={factionId}>
                <td>{faction?.name ?? factionId}</td>
                <td>{loss.personnel}</td>
                <td>{loss.strength}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 占领变更子组件 */
function ObjectiveChanges({
  changes,
  world,
}: {
  changes: ResolutionSummary['objectiveChanges']
  world: { factions: Array<{ id: string; name: string }>; map: { highValueNodes: Array<{ id: string; name: string }> } }
}): JSX.Element {
  if (changes.length === 0) {
    return <p className="briefing-panel__no-objective">本日无高价值节点易手。</p>
  }
  return (
    <div className="briefing-panel__objectives">
      <h3>节点易手</h3>
      <ul>
        {changes.map((c, i) => {
          const node = world.map.highValueNodes.find((n) => n.id === c.nodeId)
          const to = world.factions.find((f) => f.id === c.toFactionId)
          return (
            <li key={`${c.nodeId}-${i}`}>
              {node?.name ?? c.nodeId} 被 {to?.name ?? c.toFactionId} 占领
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** phase 中文名 */
function phaseName(phase: string): string {
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

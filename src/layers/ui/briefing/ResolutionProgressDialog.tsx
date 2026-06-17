/**
 * 推演即时弹窗（ResolutionProgressDialog.tsx）— Bug A 修复。
 *
 * 职责（对应「Bug A：推演即时弹窗」）：
 * - advance() 在等待 LLM 结算期间（phase==='resolution'）置 store.showResolutionProgress=true，
 *   App.tsx 据此渲染本组件（全屏叠加，深空蓝半透明 + 青光 + 扫描线）。
 * - 显示「导演部推演中...」+ 各 Agent 实时状态（参谋长/战区司令/敌方统帅/导演部），
 *   读 store.agentProgressById。
 * - 如有流式战报（store.liveReport），显示打字机效果（边出边显示）。
 * - 进度条脉冲动画（即便数据没来，玩家也看到弹窗在动，不会以为画面卡住）。
 *
 * 与 BriefingPanel 的区别：BriefingPanel 是 briefing 阶段的右栏面板（结算完成后看战报）；
 * 本组件是 resolution 阶段的全屏 modal（结算进行中的即时反馈）。
 *
 * 不 import @tauri-apps/api（UI 层）。
 *
 * @module layers/ui/briefing/ResolutionProgressDialog
 */

import { useEffect, useState, type JSX } from 'react'
import { useGameStore, type AgentProgressEntry } from '@/store/game-store'

/** Agent 角色中文显示名（与 BriefingPanel 一致） */
const ROLE_LABELS: Record<string, string> = {
  chief: '参谋长',
  theater: '战区司令',
  commander: '敌方统帅',
  director: '导演部',
}

/** Agent 状态中文显示名（与 BriefingPanel 一致） */
const STATUS_LABELS: Record<AgentProgressEntry['status'], string> = {
  thinking: '思考中',
  running: '执行中',
  adjudicating: '裁定中',
  done: '已完成',
  failed: '失败',
}

/**
 * ResolutionProgressDialog 组件。
 *
 * 由 App.tsx 在 `showResolutionProgress && phase === 'resolution'` 时渲染。
 * 全屏 modal，无关闭按钮（结算完成自动消失，玩家无需手动关）。
 */
export default function ResolutionProgressDialog(): JSX.Element {
  const agentProgressById = useGameStore((s) => s.agentProgressById)
  const liveReport = useGameStore((s) => s.liveReport)
  const streamingReport = useGameStore((s) => s.streamingReport)
  const degraded = useGameStore((s) => s.degraded)

  // 脉冲动画步进（即使无 Agent 进度数据，也展示弹窗在动）。
  // 用 setInterval 每 80ms 增 1，驱动进度条不确定态宽度扫动。
  const [pulse, setPulse] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setPulse((p) => (p + 1) % 100)
    }, 80)
    return () => window.clearInterval(id)
  }, [])

  const entries = Object.values(agentProgressById)
  // 按 role 固定顺序展示（chief/theater/commander/director）
  const order: Record<string, number> = { chief: 0, theater: 1, commander: 2, director: 3 }
  const sorted = [...entries].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9))
  const doneCount = sorted.filter((e) => e.status === 'done').length
  const failedCount = sorted.filter((e) => e.status === 'failed').length
  const pct = sorted.length === 0 ? 0 : Math.round((doneCount / sorted.length) * 100)

  return (
    <div
      className="resolution-progress-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="导演部推演中"
    >
      <div className="resolution-progress-overlay__card">
        <div className="resolution-progress-overlay__header">
          <h2 className="resolution-progress-overlay__title">
            导演部推演中
            <span className="resolution-progress-overlay__ellipsis" aria-hidden="true">…</span>
          </h2>
          <p className="resolution-progress-overlay__subtitle">
            正在汇总裁入命令、战区决策、敌方动向与导演部终裁
          </p>
        </div>

        <div className="resolution-progress-overlay__body">
          {/* 进度条：有 Agent 数据时按完成度；无数据时脉冲扫描（不确定态） */}
          <div className="resolution-progress-overlay__progress">
            {sorted.length > 0 ? (
              <div className="resolution-progress-overlay__progress-bar">
                <div
                  className="resolution-progress-overlay__progress-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : (
              <div className="resolution-progress-overlay__progress-bar resolution-progress-overlay__progress-bar--indeterminate">
                <div
                  className="resolution-progress-overlay__progress-pulse"
                  style={{ left: `${pulse}%` }}
                />
              </div>
            )}
            <span className="resolution-progress-overlay__progress-text">
              {sorted.length > 0
                ? `${doneCount}/${sorted.length} 已完成${failedCount > 0 ? ` · ${failedCount} 失败` : ''}`
                : '正在初始化结算…'}
            </span>
          </div>

          {/* 各 Agent 实时状态 */}
          {sorted.length > 0 && (
            <ul className="resolution-progress-overlay__agents">
              {sorted.map((e) => (
                <li
                  key={e.agentId}
                  className={`resolution-progress-overlay__agent resolution-progress-overlay__agent--${e.status}`}
                >
                  <span className="resolution-progress-overlay__agent-role">
                    {ROLE_LABELS[e.role] ?? e.role}
                  </span>
                  <span className="resolution-progress-overlay__agent-status">
                    {STATUS_LABELS[e.status]}
                    {e.status === 'failed' && e.error ? `：${e.error}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* 流式战报打字机（边出边显示；无战报时不渲染） */}
          {(streamingReport || liveReport.length > 0) && (
            <div className="resolution-progress-overlay__report">
              <h3 className="resolution-progress-overlay__report-title">
                战报直播
                {streamingReport && (
                  <span className="resolution-progress-overlay__live-dot" aria-hidden="true" />
                )}
              </h3>
              <pre className="resolution-progress-overlay__report-text">
                {liveReport.length > 0 ? liveReport : '（导演部正在生成战报…）'}
              </pre>
            </div>
          )}

          {degraded && (
            <p className="resolution-progress-overlay__degraded" role="status">
              导演部异常，已切规则引擎兜底（仍可完成结算，无叙事润色）
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

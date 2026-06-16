/**
 * 战果弹窗（BattleResultModal.tsx）— UI 重构第 1 批「全对话为主」。
 *
 * briefing 阶段弹窗显示本回合战果摘要：
 * - 战损表（casualties）
 * - 关键事件（objectiveChanges 节点易手）
 * - 后勤/供应链状态（各阵营 supplies/ammunition/fuel）
 * - 导演部战报（复用 store.liveReport 流式输出）
 *
 * 确认「继续」→ ENTER_PERSIST（briefing → persist）后 dismiss。
 *
 * 不 import @tauri-apps/api（UI 层）。
 *
 * @module layers/ui/briefing/BattleResultModal
 */

import { useEffect, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { isActionAllowed } from '@/layers/application/state-machine'
import type { ResolutionSummary } from '@/types'

/**
 * 战果弹窗组件。
 *
 * @param open 是否显示
 * @param onClose 关闭回调（玩家点「继续」时调用，触发 ENTER_PERSIST 后 dismiss）
 */
export default function BattleResultModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element | null {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const dispatch = useGameStore((s) => s.dispatch)
  const liveReport = useGameStore((s) => s.liveReport)
  const streamingReport = useGameStore((s) => s.streamingReport)
  const degraded = useGameStore((s) => s.degraded)

  // ESC 键关闭（与弹窗一致的无障碍快捷）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const phase = context?.game.phase
  const resolution = context?.lastResolution ?? null
  const factions = context?.game.world.factions ?? []
  const highValueNodes = context?.game.world.map.highValueNodes ?? []

  // briefing 阶段才显示战果；其他阶段不弹
  if (phase !== 'briefing' || resolution === null) return null

  const canContinue = isActionAllowed(phase, 'ENTER_PERSIST') && !busy
  // 流式战报优先（orchestrator 填充），否则用 lastResolution.reportText
  const reportText = liveReport || resolution.reportText

  /** 玩家点「继续」：ENTER_PERSIST 后关闭弹窗 */
  const handleContinue = (): void => {
    dispatch({ type: 'ENTER_PERSIST' })
    onClose()
  }

  return (
    <div
      className="battle-result-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="本回合战果"
    >
      <div className="battle-result-overlay__card">
        <div className="battle-result-overlay__header">
          <h2 className="battle-result-overlay__title">
            战报 — 第 {resolution.turn + 1} 天
            {streamingReport && <span className="battle-result-overlay__live">直播中</span>}
          </h2>
        </div>

        <div className="battle-result-overlay__body">
          {/* 导演部战报（流式） */}
          <div className="battle-result-overlay__report">
            <pre className="battle-result-overlay__report-text">
              {reportText || (streamingReport ? '（导演部正在生成战报…）' : '（本日无战事）')}
            </pre>
          </div>

          {degraded && (
            <p className="battle-result-overlay__degraded" role="alert">
              本回合为降级结算（规则引擎兜底，无叙事润色）
            </p>
          )}

          {/* 战损表 */}
          <CasualtyTable casualties={resolution.casualties} factions={factions} />

          {/* 关键事件：节点易手 */}
          <ObjectiveChanges changes={resolution.objectiveChanges} factions={factions} nodes={highValueNodes} />

          {/* 后勤/供应链状态 */}
          <SupplyStatus factions={factions} />
        </div>

        <div className="battle-result-overlay__actions">
          <button
            type="button"
            className="battle-result-overlay__continue"
            onClick={handleContinue}
            disabled={!canContinue}
          >
            继续进入持久化
          </button>
        </div>
      </div>
    </div>
  )
}

/** 战损表 */
function CasualtyTable({
  casualties,
  factions,
}: {
  casualties: ResolutionSummary['casualties']
  factions: Array<{ id: string; name: string; color?: string }>
}): JSX.Element {
  const entries = Object.entries(casualties)
  if (entries.length === 0) {
    return <p className="battle-result-overlay__none">本日无战损记录。</p>
  }
  return (
    <div className="battle-result-overlay__section">
      <h3>战损摘要</h3>
      <table>
        <thead>
          <tr><th>阵营</th><th>人员损失</th><th>战损</th></tr>
        </thead>
        <tbody>
          {entries.map(([factionId, loss]) => {
            const f = factions.find((x) => x.id === factionId)
            return (
              <tr key={factionId}>
                <td>{f?.name ?? factionId}</td>
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

/** 节点易手 */
function ObjectiveChanges({
  changes,
  factions,
  nodes,
}: {
  changes: ResolutionSummary['objectiveChanges']
  factions: Array<{ id: string; name: string }>
  nodes: Array<{ id: string; name: string }>
}): JSX.Element {
  if (changes.length === 0) {
    return <p className="battle-result-overlay__none">本日无高价值节点易手。</p>
  }
  return (
    <div className="battle-result-overlay__section">
      <h3>节点易手</h3>
      <ul className="battle-result-overlay__objectives">
        {changes.map((c, i) => {
          const node = nodes.find((n) => n.id === c.nodeId)
          const to = factions.find((f) => f.id === c.toFactionId)
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

/** 后勤/供应链状态（各阵营 supplies/ammunition/fuel） */
function SupplyStatus({
  factions,
}: {
  factions: Array<{ id: string; name: string; supply: { supplies: number; ammunition: number; fuel: number } }>
}): JSX.Element {
  if (factions.length === 0) {
    return <p className="battle-result-overlay__none">无阵营后勤数据。</p>
  }
  return (
    <div className="battle-result-overlay__section">
      <h3>后勤 / 供应链</h3>
      <table>
        <thead>
          <tr><th>阵营</th><th>物资</th><th>弹药</th><th>燃料</th></tr>
        </thead>
        <tbody>
          {factions.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td>{f.supply.supplies}</td>
              <td>{f.supply.ammunition}</td>
              <td>{f.supply.fuel}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

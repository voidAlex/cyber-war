/**
 * 战报面板（BriefingPanel.tsx）— M2 战报 UI。
 *
 * briefing 阶段显示上一回合结算结果（ResolutionSummary）：
 * - 战报文本（从 ResolutionResult.events 拼装，M3 由 LLM 润色）
 * - 战损摘要（各方人员/战损）
 * - 占领变更与胜负提示
 *
 * 「继续」→ ENTER_PERSIST（briefing → persist），后续由 advanceTurn 落盘。
 *
 * 阶段守卫：仅 briefing 阶段展示战报；其他阶段显示占位提示。
 *
 * @module layers/ui/briefing/BriefingPanel
 */

import { type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { isActionAllowed } from '@/layers/application/state-machine'
import type { ResolutionSummary } from '@/types'

/**
 * 战报面板组件。
 */
export default function BriefingPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const dispatch = useGameStore((s) => s.dispatch)

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

  return (
    <section className="panel briefing-panel">
      <h2 className="panel__title">战报 — 第 {resolution.turn + 1} 天</h2>

      {resolution.degraded && (
        <p className="briefing-panel__degraded" role="alert">
          ⚠ 本回合为降级结算（规则引擎兜底）
        </p>
      )}

      <div className="briefing-panel__report">
        <pre className="briefing-panel__text">{resolution.reportText || '（本日无战事）'}</pre>
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

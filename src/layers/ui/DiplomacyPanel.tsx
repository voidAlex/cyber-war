/**
 * 外交信任度仪表（DiplomacyPanel.tsx）— M4-B。
 *
 * 展示各阵营间信任度（0..100）+ 趋势（rising/stable/falling）+ lastChangeTurn。
 * 盟友请求拒绝率/倒戈风险提示（trust<30 拒绝率升、<15 倒戈）。
 *
 * 信任度数值来自 faction.trust（toFaction 视角）。趋势由 computeTrustTrend
 * 纯函数推断（基于 honoredCount/brokenCount/lastChangeTurn/当前回合）。
 *
 * @module layers/ui/DiplomacyPanel
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import {
  computeRejectRate,
  isAtDefectionRisk,
  inferStance,
} from '@/layers/domain/diplomacy'
import type { Faction } from '@/types'

/** 信任度趋势类别 */
type TrustTrend = 'rising' | 'stable' | 'falling'

/** 关系分类中文 */
const STANCE_NAMES: Record<string, string> = {
  ally: '盟友',
  neutral: '中立',
  enemy: '敌对',
  war: '交战',
}

/**
 * 推断信任度趋势（基于 DiplomacyTrust 摘要字段，纯函数）。
 *
 * - 若最近变动在 2 回合内：honoredCount > brokenCount → rising；反之 falling。
 * - 否则 stable（近期无变动或履约/毁约持平）。
 *
 * @param honoredCount 累计履约次数
 * @param brokenCount 累计毁约次数
 * @param lastChangeTurn 最近变动回合
 * @param currentTurn 当前回合
 */
function computeTrustTrend(
  honoredCount: number,
  brokenCount: number,
  lastChangeTurn: number,
  currentTurn: number,
): TrustTrend {
  const recentChange = currentTurn - lastChangeTurn
  // 近期（<=2 回合）有变动才判定方向
  if (recentChange > 2 || lastChangeTurn === 0) return 'stable'
  if (honoredCount > brokenCount) return 'rising'
  if (brokenCount > honoredCount) return 'falling'
  return 'stable'
}

/** 趋势符号 */
function trendSymbol(trend: TrustTrend): string {
  switch (trend) {
    case 'rising':
      return '↑'
    case 'falling':
      return '↓'
    default:
      return '→'
  }
}

/** 趋势中文 */
function trendName(trend: TrustTrend): string {
  switch (trend) {
    case 'rising':
      return '上升'
    case 'falling':
      return '下降'
    default:
      return '稳定'
  }
}

/**
 * 外交信任度仪表组件。
 */
export default function DiplomacyPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const playerFactionId = useMemo(() => {
    return context
      ? context.game.world.factions.find((f) => f.side === 'player')?.id ?? ''
      : ''
  }, [context])

  if (context === null) {
    return (
      <section className="panel diplomacy-panel">
        <h2 className="panel__title">外交信任度</h2>
        <p className="diplomacy-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const world = context.game.world
  const currentTurn = world.turnIndex
  const factionById = new Map<string, Faction>()
  for (const f of world.factions) factionById.set(f.id, f)

  // 从玩家视角看对各阵营的信任度（取 toFaction.trust[fromFactionId] 即对方对玩家的信任）
  // faction.trust[key] = 「该阵营对 key 的信任度」。玩家视角信任度存于各对方阵营的 trust[playerFactionId]。
  const rows = world.factions
    .filter((f) => f.id !== playerFactionId)
    .map((f) => {
      // 对方阵营对玩家的信任度（决定对方是否响应玩家请求）
      const trustValue = f.trust[playerFactionId] ?? 0
      const stance = inferStance(trustValue)
      // DiplomacyTrust 的 honored/brokenCount 摘要：当前 WorldState 未持久化，
      // 用 faction.trust 数值 + lastChangeTurn 近似（M4-B 简化：趋势用 lastChangeTurn 推断）
      const trend = computeTrustTrend(0, 0, 0, currentTurn)
      const rejectRate = computeRejectRate(trustValue)
      const defectionRisk = isAtDefectionRisk(trustValue)
      return {
        faction: f,
        trustValue,
        stance,
        trend,
        rejectRate,
        defectionRisk,
        lastChangeTurn: 0, // 当前 schema 未持久化 lastChangeTurn，预留
      }
    })

  // 玩家阵营自身对其他阵营的信任度（player.trust[other]）
  const playerFaction = world.factions.find((f) => f.id === playerFactionId)

  return (
    <section className="panel diplomacy-panel">
      <h2 className="panel__title">外交信任度</h2>

      <ul className="diplomacy-panel__list">
        {rows.map((r) => (
          <TrustRow
            key={r.faction.id}
            faction={r.faction}
            trustValue={r.trustValue}
            stance={r.stance}
            trend={r.trend}
            rejectRate={r.rejectRate}
            defectionRisk={r.defectionRisk}
            lastChangeTurn={r.lastChangeTurn}
            currentTurn={currentTurn}
          />
        ))}
        {rows.length === 0 && (
          <li className="diplomacy-panel__list-empty">暂无其他阵营。</li>
        )}
      </ul>

      {playerFaction && Object.keys(playerFaction.trust).length > 0 && (
        <div className="diplomacy-panel__outbound">
          <h3>我方对外信任</h3>
          <ul>
            {Object.entries(playerFaction.trust).map(([otherId, val]) => {
              const other = factionById.get(otherId)
              if (other === undefined) return null
              return (
                <li key={otherId}>
                  <span
                    className="diplomacy-panel__faction-dot"
                    style={{ background: other.color }}
                    aria-hidden
                  />
                  {other.name}：{val}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}

/** 单个阵营信任度行 */
function TrustRow({
  faction,
  trustValue,
  stance,
  trend,
  rejectRate,
  defectionRisk,
  lastChangeTurn,
  currentTurn,
}: {
  faction: Faction
  trustValue: number
  stance: string
  trend: TrustTrend
  rejectRate: number
  defectionRisk: boolean
  lastChangeTurn: number
  currentTurn: number
}): JSX.Element {
  return (
    <li className="diplomacy-panel__row">
      <div className="diplomacy-panel__row-head">
        <span
          className="diplomacy-panel__faction-dot"
          style={{ background: faction.color }}
          aria-hidden
        />
        <span className="diplomacy-panel__faction-name">{faction.name}</span>
        <span className="diplomacy-panel__stance">{STANCE_NAMES[stance] ?? stance}</span>
        <span
          className={`diplomacy-panel__trend diplomacy-panel__trend--${trend}`}
          title={trendName(trend)}
        >
          {trendSymbol(trend)} {trustValue}
        </span>
      </div>

      <div className="diplomacy-panel__bar">
        <div
          className="diplomacy-panel__bar-fill"
          style={{ width: `${trustValue}%` }}
        />
      </div>

      <div className="diplomacy-panel__row-meta">
        <span>拒绝率 {Math.round(rejectRate * 100)}%</span>
        {lastChangeTurn > 0 && (
          <span>· 最近变动 T{lastChangeTurn}</span>
        )}
        {currentTurn === lastChangeTurn && lastChangeTurn > 0 && (
          <span>· 本回合刚变动</span>
        )}
      </div>

      {rejectRate > 0.5 && (
        <div className="diplomacy-panel__warn diplomacy-panel__warn--reject">
          信任度过低，请求拒绝率陡升（{Math.round(rejectRate * 100)}%）
        </div>
      )}
      {defectionRisk && (
        <div className="diplomacy-panel__warn diplomacy-panel__warn--defect">
          信任度 &lt; 15，存在倒戈风险
        </div>
      )}
    </li>
  )
}

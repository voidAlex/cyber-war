/**
 * 情报置信度看板（IntelligencePanel.tsx）— M4-B。
 *
 * 展示玩家阵营对各敌方单位的情报状态：
 * - 各单位对玩家阵营的情报级别（L0 盲区不显示 / L1 热力脉冲 / L2 编制确认 / L3 全量透视）。
 * - 残影状态 + 最后侦察回合 + [T-Nh] 标记。
 * - 己方 deception（诱饵/欺骗）单位提示。
 *
 * 渲染决策来自纯函数 intel-visibility（computeIntelRender / listObservedEnemyUnits），
 * 本组件只做展示，不做可见性判定。
 *
 * @module layers/ui/IntelligencePanel
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import {
  computeIntelRender,
  getPlayerFactionId,
  ghostLabel,
  visibleFieldsFor,
  type IntelRenderDecision,
} from '@/layers/ui/sandbox/intel-visibility'
import type { IntelLevel, Unit, Faction } from '@/types'

/** 情报级别中文标签 */
const LEVEL_NAMES: Record<IntelLevel, string> = {
  0: '盲区',
  1: '热力脉冲',
  2: '编制确认',
  3: '全量透视',
}

/** 情报级别标签配色（边框/文字色） */
const LEVEL_COLORS: Record<IntelLevel, string> = {
  0: '#6b6b6b',
  1: '#e69138',
  2: '#f1c232',
  3: '#4caf50',
}

/**
 * 情报置信度看板组件。
 */
export default function IntelligencePanel(): JSX.Element {
  const context = useGameStore((s) => s.context)

  const playerFactionId = useMemo(() => {
    return context ? getPlayerFactionId(context.game.world.factions) : ''
  }, [context])

  const currentTurn = context?.game.world.turnIndex ?? 0
  const halfLifeTurns = context?.game.world.intel.decayRule.halfLifeTurns ?? 3

  // 未加载存档
  if (context === null) {
    return (
      <section className="panel intelligence-panel">
        <h2 className="panel__title">情报置信度</h2>
        <p className="intelligence-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const world = context.game.world
  const factionById = new Map<string, Faction>()
  for (const f of world.factions) factionById.set(f.id, f)

  // 玩家阵营对敌方单位的情报渲染决策
  const enemyRenders: Array<{ unit: Unit; render: IntelRenderDecision }> = []
  for (const unit of world.units) {
    if (unit.factionId === playerFactionId) continue
    const render = computeIntelRender(
      unit,
      playerFactionId,
      currentTurn,
      halfLifeTurns,
    )
    enemyRenders.push({ unit, render })
  }

  // 排序：先显示有情报的（非 L0），再按级别降序；L0 排末位
  const sorted = [...enemyRenders].sort((a, b) => {
    if (a.render.level !== b.render.level) return b.render.level - a.render.level
    return a.unit.id.localeCompare(b.unit.id)
  })

  // 己方 deception 单位（玩家可见的诱饵/欺骗提示）
  const ownDeceptions = world.units.filter(
    (u) => u.factionId === playerFactionId && u.deception === true,
  )

  // 统计：各级别单位数
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<IntelLevel, number>
  for (const { render } of enemyRenders) counts[render.level]++

  return (
    <section className="panel intelligence-panel">
      <h2 className="panel__title">情报置信度</h2>

      <div className="intelligence-panel__summary">
        <LevelChip level={3} count={counts[3]} />
        <LevelChip level={2} count={counts[2]} />
        <LevelChip level={1} count={counts[1]} />
        <LevelChip level={0} count={counts[0]} />
      </div>

      <ul className="intelligence-panel__list">
        {sorted.map(({ unit, render }) => (
          <IntelRow
            key={unit.id}
            unit={unit}
            render={render}
            factionName={factionById.get(unit.factionId)?.name ?? unit.factionId}
            factionColor={factionById.get(unit.factionId)?.color ?? '#888'}
          />
        ))}
        {sorted.length === 0 && (
          <li className="intelligence-panel__list-empty">暂无敌方单位情报。</li>
        )}
      </ul>

      {ownDeceptions.length > 0 && (
        <div className="intelligence-panel__deception">
          <h3>己方欺骗单位</h3>
          <ul>
            {ownDeceptions.map((u) => (
              <li key={u.id}>
                <span className="intelligence-panel__deception-mark">诱饵</span>
                {u.id}（{factionById.get(u.factionId)?.name ?? u.factionId}）
              </li>
            ))}
          </ul>
          <p className="intelligence-panel__deception-hint">
            这些单位用于战略欺骗，敌方可能被误导。
          </p>
        </div>
      )}
    </section>
  )
}

/** 情报级别计数 chip */
function LevelChip({ level, count }: { level: IntelLevel; count: number }): JSX.Element {
  return (
    <div
      className="intelligence-panel__chip"
      style={{ borderColor: LEVEL_COLORS[level] }}
    >
      <span
        className="intelligence-panel__chip-level"
        style={{ color: LEVEL_COLORS[level] }}
      >
        L{level}
      </span>
      <span className="intelligence-panel__chip-name">{LEVEL_NAMES[level]}</span>
      <span className="intelligence-panel__chip-count">{count}</span>
    </div>
  )
}

/** 单个敌方单位的情报行 */
function IntelRow({
  unit,
  render,
  factionName,
  factionColor,
}: {
  unit: Unit
  render: IntelRenderDecision
  factionName: string
  factionColor: string
}): JSX.Element {
  const label = ghostLabel(render)
  const fields = visibleFieldsFor(render)
  return (
    <li className="intelligence-panel__row" data-level={render.level}>
      <span
        className="intelligence-panel__faction-dot"
        style={{ background: factionColor }}
        aria-hidden
      />
      <div className="intelligence-panel__row-main">
        <div className="intelligence-panel__row-head">
          <span className="intelligence-panel__unit-id">{unit.id}</span>
          <span
            className="intelligence-panel__level-badge"
            style={{ borderColor: LEVEL_COLORS[render.level], color: LEVEL_COLORS[render.level] }}
          >
            L{render.level} {LEVEL_NAMES[render.level]}
          </span>
          {render.ghost && (
            <span className="intelligence-panel__ghost" title="情报已过期，显示残影">
              残影 {label}
            </span>
          )}
        </div>
        <div className="intelligence-panel__row-meta">
          <span>{factionName}</span>
          {fields.includes('type') && <span>· {TYPE_NAMES[unit.type]}</span>}
          {render.lastSeenTurn > 0 && (
            <span>· 最后侦察 T{render.lastSeenTurn}</span>
          )}
          {render.lastSeenTurn === 0 && render.level > 0 && (
            <span>· 从未侦察</span>
          )}
        </div>
      </div>
    </li>
  )
}

/** 单位类型中文 */
const TYPE_NAMES: Record<string, string> = {
  infantry: '步兵',
  armor: '装甲',
  artillery: '炮兵',
  recon: '侦察',
  fortress: '要塞守备',
  support: '支援',
}

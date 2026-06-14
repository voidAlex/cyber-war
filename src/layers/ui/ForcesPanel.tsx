/**
 * 部队列表面板（ForcesPanel.tsx）— UI 重构第 3 批「C 单位详情」。
 *
 * 职责：
 * - 左栏「信息」组面板，列出玩家阵营（side=player）的全部单位。
 * - 每条：单位 id + 类型中文 + 强度摘要条 + 状态 chip + 坐标 cellId。
 * - 点击某条 → store.setSelectedUnitId(unitId) → UnitDetailPanel 弹 + 沙盘青光描边。
 * - 选中态：被点击条高亮（青光描边）。
 * - 己方单位恒全量（不做情报裁剪）。
 * - 虚拟滚动：单位 > 50 时用 max-height + overflow-y auto（CSS 滚动），
 *   避免 DOM 节点爆炸；纯 CSS 滚动比 react-window 轻，单位数量级（< 几百）够用。
 *
 * 不 import @tauri-apps/api（UI 层纯展示）。
 *
 * @module layers/ui/units/ForcesPanel
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { getPlayerFactionId } from '@/layers/ui/sandbox/intel-visibility'
import { cellIdFromCoord } from '@/layers/ui/sandbox/coords'
import { UNIT_TYPE_GLYPH, UNIT_TYPE_NAMES } from '@/layers/ui/units/unit-glyph'
import type { Unit } from '@/types'

/** 状态 flag 单字标识（列表条紧凑 chip）。 */
const STATUS_GLYPH: Record<string, string> = {
  engaged: '战',
  suppressed: '压',
  pinned: '钉',
  retreating: '撤',
  low_supply: '缺',
  decoy: '伪',
}

/** 强度条配色（与 UnitDetailPanel levelColor 同语义，但列表条内联用 class）。 */
function strengthClass(ratio: number): string {
  if (ratio > 0.66) return 'forces-row__bar-fill--high'
  if (ratio < 0.33) return 'forces-row__bar-fill--low'
  return 'forces-row__bar-fill--mid'
}

/**
 * 部队列表面板组件。
 *
 * 从 store 取玩家阵营单位 + selectedUnitId；点击行 setSelectedUnitId。
 */
export default function ForcesPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const selectedUnitId = useGameStore((s) => s.selectedUnitId)
  const setSelectedUnitId = useGameStore((s) => s.setSelectedUnitId)

  // 玩家阵营单位列表（按 id 排序稳定；己方全量）
  const ownUnits = useMemo((): Unit[] => {
    if (context === null) return []
    const world = context.game.world
    const playerFactionId = getPlayerFactionId(world.factions)
    if (playerFactionId.length === 0) return []
    return world.units
      .filter((u) => u.factionId === playerFactionId)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }, [context])

  // 未加载存档
  if (context === null) {
    return (
      <section className="panel forces-panel">
        <h2 className="panel__title">部队</h2>
        <p className="forces-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  return (
    <section className="panel forces-panel">
      <h2 className="panel__title">
        部队
        <span className="forces-panel__count">{ownUnits.length}</span>
      </h2>

      {ownUnits.length === 0 ? (
        <p className="forces-panel__empty">玩家阵营暂无单位。</p>
      ) : (
        <ul className="forces-panel__list">
          {ownUnits.map((unit) => {
            const isSelected = unit.id === selectedUnitId
            const strengthRatio = unit.strength / 100
            const cellId = cellIdFromCoord(unit.coord.col, unit.coord.row)
            return (
              <li key={unit.id}>
                <button
                  type="button"
                  className={
                    'forces-row' + (isSelected ? ' forces-row--selected' : '')
                  }
                  onClick={() => setSelectedUnitId(unit.id)}
                  aria-pressed={isSelected}
                  aria-label={`选中单位 ${unit.id}`}
                >
                  {/* 类型 glyph 圆徽（赛博朋克单字标识） */}
                  <span className="forces-row__glyph" aria-hidden>
                    {UNIT_TYPE_GLYPH[unit.type]}
                  </span>

                  <div className="forces-row__main">
                    <div className="forces-row__head">
                      <span className="forces-row__id">{unit.id}</span>
                      <span className="forces-row__type">
                        {UNIT_TYPE_NAMES[unit.type]}
                      </span>
                      <span className="forces-row__coord">{cellId}</span>
                    </div>
                    <div className="forces-row__bar">
                      <div
                        className={`forces-row__bar-fill ${strengthClass(strengthRatio)}`}
                        style={{
                          width: `${Math.max(0, Math.min(100, Math.round(strengthRatio * 100)))}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* 状态 chip 列（紧凑单字） */}
                  {unit.status.length > 0 && (
                    <div className="forces-row__status">
                      {unit.status.map((flag) => (
                        <span
                          key={flag}
                          className={`forces-row__status-chip forces-row__status-chip--${flag}`}
                          title={STATUS_GLYPH[flag] ?? flag}
                        >
                          {STATUS_GLYPH[flag] ?? '?'}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

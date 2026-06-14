/**
 * 单位详情浮层（UnitDetailPanel.tsx）— UI 重构第 3 批「C 单位详情」。
 *
 * 职责：
 * - 当 store.selectedUnitId 非空时，浮层展示该单位的完整属性：
 *   type/strength/personnel(maxPersonnel)/fuel/ammo/morale/fatigue/status[]/orders[]/coord。
 * - 赛博朋克青光数据表（Orbitron 标题 + 青光描边 + 数据条 + chip）。
 * - 情报限制（参考 intel-visibility）：敌方单位按观察方对其的 IntelLevel 裁剪字段：
 *   · L0 盲区：不会出现在 selectedUnitId（玩家本就看不到，但防御性渲染空态）。
 *   · L1 热力脉冲：仅位置/阵营（无精确数值，详情面板基本空）。
 *   · L2 编制确认：+ 类型 + 坐标（无血量/补给）。
 *   · L3 / 己方：全字段（strength/personnel/fuel/ammo/morale/fatigue + status + orders）。
 * - 关闭按钮调 store.clearSelectedUnit。
 *
 * 不 import @tauri-apps/api（UI 层纯展示）；情报判定走纯函数 intel-visibility。
 *
 * @module layers/ui/units/UnitDetailPanel
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import {
  computeIntelRender,
  getPlayerFactionId,
  visibleFieldsFor,
  type IntelRenderDecision,
} from '@/layers/ui/sandbox/intel-visibility'
import { cellIdFromCoord } from '@/layers/ui/sandbox/coords'
import { UNIT_TYPE_NAMES } from '@/layers/ui/units/unit-glyph'
import type { Faction, Unit } from '@/types'

/** 状态 flag 中文标签（chip 显示）。 */
const STATUS_LABELS: Record<string, string> = {
  engaged: '交战中',
  suppressed: '被压制',
  pinned: '被钉住',
  retreating: '撤退中',
  low_supply: '低补给',
  decoy: '诱饵',
}

/** 单条数据条配置（label + 当前值 + 最大值 + 颜色策略）。 */
interface MetricRow {
  /** 字段 key（用于 data-key）。 */
  key: string
  /** 中文标签。 */
  label: string
  /** 当前值。 */
  value: number
  /** 最大值（用于百分比；strength/fuel/ammo/morale/fatigue 用 100，personnel 用 maxPersonnel）。 */
  max: number
  /** 是否反向（值越高越坏，如 fatigue）——影响配色方向。 */
  inverse?: boolean
}

/**
 * 按数值占比返回配色（高绿/中黄/低红）。
 * inverse=true 时方向相反（高=红，如 fatigue）。
 */
function levelColor(ratio: number, inverse = false): string {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio
  // 阈值：>0.66 高 / 0.33..0.66 中 / <0.33 低
  const high = inverse ? r > 0.66 : r > 0.66
  const low = inverse ? r < 0.33 : r < 0.33
  if (high) return 'metric--high'
  if (low) return 'metric--low'
  return 'metric--mid'
}

/**
 * 单位详情浮层组件。
 *
 * 从 store 取 selectedUnitId + world，按情报级别裁剪后渲染。
 * selectedUnitId 为 null 或单位不存在时返回 null（不渲染浮层）。
 */
export default function UnitDetailPanel(): JSX.Element | null {
  const context = useGameStore((s) => s.context)
  const selectedUnitId = useGameStore((s) => s.selectedUnitId)
  const clearSelectedUnit = useGameStore((s) => s.clearSelectedUnit)

  // 计算当前选中单位 + 其对玩家方的情报渲染决策（裁剪字段用）。
  const resolved = useMemo((): {
    unit: Unit
    faction: Faction
    decision: IntelRenderDecision
    visible: ReadonlyArray<string>
  } | null => {
    if (context === null || selectedUnitId === null) return null
    const world = context.game.world
    const unit = world.units.find((u) => u.id === selectedUnitId)
    if (unit === undefined) return null
    const faction = world.factions.find((f) => f.id === unit.factionId)
    if (faction === undefined) return null
    const playerFactionId = getPlayerFactionId(world.factions)
    const currentTurn = world.turnIndex
    const halfLifeTurns = world.intel.decayRule.halfLifeTurns ?? 3
    // 无观察方时（极少见）：按己方全量渲染
    const decision: IntelRenderDecision =
      playerFactionId.length === 0
        ? {
            unitId: unit.id,
            mode: 'own',
            level: 3,
            ghost: false,
            ghostTurns: 0,
            staleTurns: 0,
            lastSeenTurn: currentTurn,
          }
        : computeIntelRender(unit, playerFactionId, currentTurn, halfLifeTurns)
    const visible = visibleFieldsFor(decision)
    return { unit, faction, decision, visible }
  }, [context, selectedUnitId])

  if (resolved === null) return null
  const { unit, faction, decision, visible } = resolved

  // visibleFields 集合（O(1) 查询某字段是否可见）
  const vis = new Set(visible)
  const isFull = decision.mode === 'full' || decision.mode === 'own'
  const cellId = cellIdFromCoord(unit.coord.col, unit.coord.row)

  // 构造数据条列表（仅 full/own 模式有数值字段；formation/heat-pulse 略）
  const metrics: MetricRow[] = isFull
    ? [
        { key: 'strength', label: '战斗力', value: unit.strength, max: 100 },
        {
          key: 'personnel',
          label: '兵员',
          value: unit.personnel,
          max: unit.maxPersonnel,
        },
        { key: 'fuel', label: '燃料', value: unit.fuel, max: 100 },
        { key: 'ammo', label: '弹药', value: unit.ammo, max: 100 },
        { key: 'morale', label: '士气', value: unit.morale, max: 100 },
        {
          key: 'fatigue',
          label: '疲劳',
          value: unit.fatigue,
          max: 100,
          inverse: true,
        },
      ]
    : []

  return (
    <aside
      className="unit-detail-panel"
      role="dialog"
      aria-label={`单位详情 ${unit.id}`}
      data-level={decision.level}
    >
      {/* 角装饰（赛博朋克 L 形角括号，由 CSS ::before/::after 实现） */}
      <div className="unit-detail-panel__header">
        <div className="unit-detail-panel__title-row">
          {/* 阵营色色块（己方/L1+ 都可见阵营） */}
          <span
            className="unit-detail-panel__faction-dot"
            style={{ background: faction.color }}
            aria-hidden
          />
          <h3 className="unit-detail-panel__title">
            <span className="unit-detail-panel__unit-id">{unit.id}</span>
            <span className="unit-detail-panel__unit-type">
              {UNIT_TYPE_NAMES[unit.type]}
            </span>
          </h3>
        </div>
        <button
          type="button"
          className="unit-detail-panel__close"
          onClick={clearSelectedUnit}
          aria-label="关闭单位详情"
        >
          ×
        </button>
      </div>

      {/* 阵营名 + 坐标 + 情报级别（formation 以上可见阵营名；heat-pulse 仅位置） */}
      <div className="unit-detail-panel__meta">
        {vis.has('faction') && (
          <span className="unit-detail-panel__meta-item">
            <span className="unit-detail-panel__meta-label">阵营</span>
            <span className="unit-detail-panel__meta-value">{faction.name}</span>
          </span>
        )}
        {vis.has('coord') && (
          <span className="unit-detail-panel__meta-item">
            <span className="unit-detail-panel__meta-label">坐标</span>
            <span className="unit-detail-panel__meta-value">
              {cellId}{' '}
              <span className="unit-detail-panel__coord-raw">
                ({unit.coord.col},{unit.coord.row})
              </span>
            </span>
          </span>
        )}
        <span className="unit-detail-panel__meta-item">
          <span className="unit-detail-panel__meta-label">情报</span>
          <span className="unit-detail-panel__meta-value unit-detail-panel__intel">
            {decision.mode === 'own'
              ? '己方'
              : decision.mode === 'full'
                ? 'L3 全量'
                : decision.mode === 'formation'
                  ? 'L2 编制'
                  : decision.mode === 'heat-pulse'
                    ? 'L1 热力'
                    : 'L0 盲区'}
          </span>
        </span>
      </div>

      {/* 数据条（仅 full/own 模式渲染；敌方低情报级别时显示提示） */}
      {isFull ? (
        <div className="unit-detail-panel__metrics">
          {metrics.map((m) => {
            const ratio = m.max <= 0 ? 0 : m.value / m.max
            const pct = Math.round(ratio * 100)
            return (
              <div className="unit-detail__metric" key={m.key}>
                <div className="unit-detail__metric-head">
                  <span className="unit-detail__metric-label">{m.label}</span>
                  <span className="unit-detail__metric-value">
                    {Math.round(m.value)}
                    {m.key === 'personnel' ? `/${m.max}` : ''}
                    <span className="unit-detail__metric-pct">{pct}%</span>
                  </span>
                </div>
                <div className="unit-detail__bar">
                  <div
                    className={`unit-detail__bar-fill ${levelColor(ratio, m.inverse)}`}
                    style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="unit-detail-panel__masked">
          {decision.mode === 'formation'
            ? '编制已确认，精确战力需更高级别情报。'
            : decision.mode === 'heat-pulse'
              ? '仅探测到热力信号，无法辨识属性。'
              : '该单位情报不足，无可展示属性。'}
        </p>
      )}

      {/* 状态 flag chip（仅 full/own） */}
      {isFull && (
        <div className="unit-detail-panel__status-row">
          {unit.status.length === 0 ? (
            <span className="unit-detail-panel__status-chip unit-detail-panel__status-chip--ok">
              就绪
            </span>
          ) : (
            unit.status.map((flag) => (
              <span
                key={flag}
                className={`unit-detail-panel__status-chip unit-detail-panel__status-chip--${flag}`}
              >
                {STATUS_LABELS[flag] ?? flag}
              </span>
            ))
          )}
        </div>
      )}

      {/* 命令队列（仅 full/own；orders 是 ActionEnvelope 引用 id 列表） */}
      {isFull && (
        <div className="unit-detail-panel__orders">
          <div className="unit-detail-panel__orders-head">本回合命令</div>
          {unit.orders.length === 0 ? (
            <span className="unit-detail-panel__orders-empty">无待执行命令</span>
          ) : (
            <ul className="unit-detail-panel__orders-list">
              {unit.orders.map((orderId, i) => (
                <li key={`${orderId}-${i}`} className="unit-detail-panel__order-item">
                  <span className="unit-detail-panel__order-idx">{i + 1}.</span>
                  <span className="unit-detail-panel__order-id">{orderId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  )
}

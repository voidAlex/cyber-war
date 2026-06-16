/**
 * 沙盘 cell 悬浮信息浮层（CellTooltip.tsx）— UI 重构第 3 批。
 *
 * 职责：当 store.hoveredCellId 非空（鼠标悬浮沙盘某格）时，在该格附近显示
 * DOM 浮层，呈现：
 * - 坐标（cellId 如 C3 / col,row）
 * - 地形中文名 + defenseBonus（防御加成）
 * - 是否高价值节点（节点名，如「杜奥蒙堡」）
 * - 该格上的单位简报（id + 类型 + 阵营色 + 强度条；多单位全部列出）
 * - 是否在补给线上（沿 map.supplyNetwork.lines 的 cellIds 命中）
 *
 * 设计约束：
 * - 纯 DOM/CSS 浮层，pointer-events:none（绝不遮挡沙盘交互）。
 * - 不 import @tauri-apps/api（UI 层）。
 * - 跟随鼠标位置（由父容器传入 mousePos 或固定右上角——本组件固定右上角，
 *   避免鼠标移动导致浮层抖动，且不与单位军标争夺视线）。
 *
 * 数据来源：store.context.game.world（map/units/factions）+ store.hoveredCellId。
 * cellId 格式为「列字母+1起步行号」（如 C3），需反查 map.cells（id 格式 cell-{col}-{row}
 * 或 col:row），通过坐标 col/row 比较（双向容错）。
 *
 * @module layers/ui/sandbox/CellTooltip
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { coordFromCellId } from './coords'
import { UNIT_TYPE_NAMES } from '@/layers/ui/units/unit-glyph'
import type { Faction, Unit, GameMap } from '@/types'

/** 地形中文名表（与 theme.TERRAIN_COLORS 一一对应，用于 tooltip 文本展示）。 */
const TERRAIN_NAMES: Record<string, string> = {
  plain: '平原',
  forest: '森林',
  mountain: '山地',
  water: '水域',
  urban: '城镇',
  fortress: '要塞',
  marsh: '沼泽',
}

/**
 * 解析 cellId（如 "C3"）为 {col,row}，失败返回 null。
 *
 * 容错包装 coordFromCellId（后者解析失败抛 RangeError）。本组件用 null 判定
 * 「未悬浮合法格」而非抛错，避免鼠标快速划过边界导致渲染期异常。
 */
function safeParseCellId(cellId: string): { col: number; row: number } | null {
  try {
    return coordFromCellId(cellId)
  } catch {
    return null
  }
}

/**
 * 判断 cellId 是否在补给线网络上（沿 map.supplyNetwork.lines 的 cellIds 命中）。
 *
 * cellIds 元素格式可能为 cell-{col}-{row} 或 col:row；统一归一为坐标比较。
 * 无 supplyNetwork 时返回 false（无补给网络概念）。
 */
function isOnSupplyLine(map: GameMap, col: number, row: number): boolean {
  const lines = map.supplyNetwork?.lines
  if (!lines || lines.length === 0) return false
  for (const line of lines) {
    for (const rawCellId of line.cellIds) {
      const c = safeParseNormalizedCellId(rawCellId)
      if (c !== null && c.col === col && c.row === row) return true
    }
  }
  return false
}

/**
 * 解析多种 cellId 格式（cell-{col}-{row} / col:row / 字母+数字）为坐标。
 * 内部用：兼容 supplyNetwork.cellIds 的数据格式（map.ts 用 cell-{col}-{row}）。
 */
function safeParseNormalizedCellId(cellId: string): { col: number; row: number } | null {
  const trimmed = cellId.trim()
  // cell-{col}-{row}
  const m1 = /^cell-(\d+)-(\d+)$/i.exec(trimmed)
  if (m1) {
    return { col: Number(m1[1]), row: Number(m1[2]) }
  }
  // col:row
  const m2 = /^(\d+):(\d+)$/.exec(trimmed)
  if (m2) {
    return { col: Number(m2[1]), row: Number(m2[2]) }
  }
  // 字母+数字（C3）
  return safeParseCellId(trimmed)
}

/**
 * 沙盘 cell 悬浮信息浮层组件。
 *
 * 从 store 读 hoveredCellId + world，反查该格地形/节点/单位/补给线，渲染浮层。
 * hoveredCellId 为 null 或反查失败时返回 null（不渲染）。
 */
export default function CellTooltip(): JSX.Element | null {
  const context = useGameStore((s) => s.context)
  const hoveredCellId = useGameStore((s) => s.hoveredCellId)

  const info = useMemo((): {
    cellId: string
    col: number
    row: number
    terrainName: string
    defenseBonus: number
    isObjective: boolean
    nodeName: string | null
    isSupplySource: boolean
    onSupplyLine: boolean
    units: Array<{ unit: Unit; faction: Faction; typeName: string }>
  } | null => {
    if (context === null || hoveredCellId === null) return null
    const coord = safeParseCellId(hoveredCellId)
    if (coord === null) return null
    const world = context.game.world
    const map = world.map
    // 反查 cell（map.cells 的 id 格式可能是 cell-{col}-{row} 或 col:row）。
    // 用 col/row 直接比较，避免依赖 cell.id 命名风格。
    const cell = map.cells.find((c) => c.col === coord.col && c.row === coord.row)
    if (cell === undefined) return null

    // 高价值节点（cellId 与 hoveredCellId 通过坐标反查）
    const node = map.highValueNodes.find((n) => {
      const nc = safeParseNormalizedCellId(n.cellId)
      return nc !== null && nc.col === coord.col && nc.row === coord.row
    })

    // 该格上的单位（按 coord 直接比较）
    const factionById = new Map<string, Faction>()
    for (const f of world.factions) factionById.set(f.id, f)
    const unitsOnCell: Array<{ unit: Unit; faction: Faction; typeName: string }> = []
    for (const u of world.units) {
      if (u.coord.col === coord.col && u.coord.row === coord.row) {
        const faction = factionById.get(u.factionId)
        if (faction === undefined) continue
        unitsOnCell.push({
          unit: u,
          faction,
          typeName: UNIT_TYPE_NAMES[u.type] ?? u.type,
        })
      }
    }

    return {
      cellId: hoveredCellId,
      col: coord.col,
      row: coord.row,
      terrainName: TERRAIN_NAMES[cell.terrain] ?? cell.terrain,
      defenseBonus: cell.defenseBonus,
      isObjective: cell.isObjective || node !== undefined,
      nodeName: node ? node.name : null,
      isSupplySource: cell.isSupplySource === true,
      onSupplyLine: isOnSupplyLine(map, coord.col, coord.row),
      units: unitsOnCell,
    }
  }, [context, hoveredCellId])

  if (info === null) return null

  return (
    <div className="cell-tooltip" role="status" aria-label={`沙盘格子 ${info.cellId}`}>
      <div className="cell-tooltip__header">
        <span className="cell-tooltip__coord">{info.cellId}</span>
        <span className="cell-tooltip__coord-raw">{info.col},{info.row}</span>
      </div>
      <dl className="cell-tooltip__rows">
        <div className="cell-tooltip__row">
          <dt>地形</dt>
          <dd>{info.terrainName}</dd>
        </div>
        <div className="cell-tooltip__row">
          <dt>防御</dt>
          <dd>+{Math.round(info.defenseBonus * 100)}%</dd>
        </div>
        {info.nodeName !== null && (
          <div className="cell-tooltip__row cell-tooltip__row--node">
            <dt>节点</dt>
            <dd>{info.nodeName}</dd>
          </div>
        )}
        {info.isSupplySource && (
          <div className="cell-tooltip__row cell-tooltip__row--supply">
            <dt>补给源</dt>
            <dd>是</dd>
          </div>
        )}
        {info.onSupplyLine && (
          <div className="cell-tooltip__row cell-tooltip__row--supply">
            <dt>补给线</dt>
            <dd>在线上</dd>
          </div>
        )}
      </dl>
      {info.units.length > 0 && (
        <ul className="cell-tooltip__units">
          {info.units.map(({ unit, faction, typeName }) => (
            <li key={unit.id} className="cell-tooltip__unit">
              <span
                className="cell-tooltip__faction-dot"
                style={{ background: faction.color }}
                aria-hidden="true"
              />
              <span className="cell-tooltip__unit-id">{unit.id}</span>
              <span className="cell-tooltip__unit-type">{typeName}</span>
              {/* 强度条（与 UnitDetailPanel 配色一致：高绿/中黄/低红） */}
              <span
                className={
                  'cell-tooltip__strength ' +
                  (unit.strength > 66
                    ? 'cell-tooltip__strength--high'
                    : unit.strength < 33
                      ? 'cell-tooltip__strength--low'
                      : 'cell-tooltip__strength--mid')
                }
                aria-label={`强度 ${unit.strength}`}
              >
                <span
                  className="cell-tooltip__strength-bar"
                  style={{ width: `${Math.max(0, Math.min(100, unit.strength))}%` }}
                />
                <span className="cell-tooltip__strength-text">{unit.strength}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

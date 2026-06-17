/**
 * 后勤面板（SupplyPanel.tsx）— UI 扩展第 1 批「后勤/决策」。
 *
 * 职责（对应重写计划第 1 批「后勤面板」）：
 * - 补给线列表：每条 SupplyLine 渲染阵营色标 + 路径摘要（cellId 序列，转 UI 友好 "C3" 格式）
 *   + 连通状态（绿"连通"/红"切断 @ {blockedAt}"）。
 * - 单位补给状态：按 faction 分组调 computeSupplyConnectivity，
 *   列出 low_supply 单位（红标 + blockedAt 位置）。
 * - 补给源列表：isSupplySource=true 的 cell + 所属阵营（按其是否落在某阵营 SupplyLine 的
 *   cellIds[0] 判定归属）。
 *
 * 数据源（复用现有，不新增数据结构）：
 * - world.map.supplyNetwork.lines（补给线声明）
 * - world.units（单位 + status low_supply 标记）
 * - world.cells（isSupplySource）
 * - world.factions（阵营色/名）
 * - computeSupplyConnectivity（supply.ts 纯函数，判定每单位连通性 + blockedAt）
 *
 * 缺省兼容：map.supplyNetwork===undefined 时显示"本战役无补给网络（点状补给）"，
 * 不阻断 UI（与 computeSupplyConnectivity 的缺省连通语义一致）。
 *
 * 不 import @tauri-apps/api（UI 层纯展示）。
 *
 * @module layers/ui/SupplyPanel
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { computeSupplyConnectivity } from '@/layers/domain/supply'
import { cellIdFromCoord } from '@/layers/ui/sandbox/coords'
import { UNIT_TYPE_NAMES } from '@/layers/ui/units/unit-glyph'
import type { Faction, Unit } from '@/types'

/** SupplyLineType 中文标签（影响切断难度与叙事）。 */
const LINE_TYPE_NAMES: Record<string, string> = {
  road: '公路',
  rail: '铁路',
  river: '水运',
}

/**
 * 把补给线内部 cellId（"col:row" 或 "cell-{col}-{row}"）归一为 "col:row"。
 *
 * 与 supply.ts 的 normalizeCellId 同语义（本地副本，避免 import 私有导出）。
 * 未知格式原样返回。
 */
function normalizeSupplyCellId(cellId: string): string {
  if (/^-?\d+:-?\d+$/.test(cellId)) return cellId
  const m = /^cell-(\d+)-(\d+)$/.exec(cellId)
  if (m && m[1] !== undefined && m[2] !== undefined) return `${m[1]}:${m[2]}`
  return cellId
}

/**
 * 把补给线内部 cellId 转为 UI 友好的 "C3" 格式（列字母+行号1起）。
 *
 * 失败回退原值（不阻断渲染）。
 */
function toUiCellId(cellId: string): string {
  const norm = normalizeSupplyCellId(cellId)
  const m = /^(-?\d+):(-?\d+)$/.exec(norm)
  if (m === null || m[1] === undefined || m[2] === undefined) return cellId
  const col = Number(m[1])
  const row = Number(m[2])
  if (!Number.isInteger(col) || !Number.isInteger(row)) return cellId
  try {
    return cellIdFromCoord(col, row)
  } catch {
    return cellId
  }
}

/** 单条补给线展示行计算结果。 */
interface LineRow {
  /** 线 id */
  id: string
  /** 阵营 */
  faction: Faction
  /** 线类别中文 */
  typeName: string
  /** 路径摘要（UI "C3" 格式序列，截断长路径） */
  pathSummary: string
  /** 是否连通（该阵营任一单位在此线且无阻断即视为连通） */
  connected: boolean
  /** 被阻断的 UI cellId（connected=false 时填） */
  blockedAtUi?: string
}

/** 低补给单位行。 */
interface LowSupplyRow {
  unit: Unit
  faction: Faction
  /** 被阻断的 UI cellId（来自 computeSupplyConnectivity.blockedAt） */
  blockedAtUi?: string
  /** cellId（单位所在格，UI 格式） */
  cellId: string
  /** 触发原因：status 含 low_supply 或 连通性判定为切断 */
  reason: 'severed' | 'flagged'
}

/** 补给源行。 */
interface SourceRow {
  cellId: string
  faction?: Faction
}

/**
 * 后勤面板组件。
 *
 * 从 store.context.game.world 取 map.supplyNetwork / units / cells / factions，
 * 调 computeSupplyConnectivity 计算连通性，渲染三段：补给线 / 低补给单位 / 补给源。
 */
export default function SupplyPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)

  // 三段数据派生（world 不变时缓存）
  const { lineRows, lowSupplyRows, sourceRows, hasNetwork } = useMemo(() => {
    if (context === null) {
      return {
        lineRows: [] as LineRow[],
        lowSupplyRows: [] as LowSupplyRow[],
        sourceRows: [] as SourceRow[],
        hasNetwork: false,
      }
    }
    const world = context.game.world
    const map = world.map
    const factionById = new Map<string, Faction>()
    for (const f of world.factions) factionById.set(f.id, f)

    const lines = map.supplyNetwork?.lines ?? []
    const hasNet = lines.length > 0

    // —— 补给线展示行 ——
    // 每条线：取其阵营；连通性 = 该阵营所有位于此线的单位是否存在任一未阻断路径。
    // blockedAt 取该阵营此线阻断单位的首个 blockedAt（便于高亮瓶颈）。
    const lineRows: LineRow[] = lines.map((line) => {
      const faction = factionById.get(line.factionId)
      // 该阵营在此线的单位（位置匹配 line.cellIds）
      const unitsOnLine = world.units.filter(
        (u) =>
          u.factionId === line.factionId &&
          u.strength > 0 &&
          line.cellIds.some(
            (cid) => normalizeSupplyCellId(cid) === `${u.coord.col}:${u.coord.row}`,
          ),
      )
      // 调 computeSupplyConnectivity（按 faction 全量计算一次，此处复用）
      const conn = computeSupplyConnectivity(map, world.units, line.factionId)
      let connected = false
      let blockedAtUi: string | undefined
      for (const u of unitsOnLine) {
        const c = conn.get(u.id)
        if (c && c.connected) {
          connected = true
          break
        }
        if (c && !c.connected && c.blockedAt !== undefined && blockedAtUi === undefined) {
          blockedAtUi = toUiCellId(c.blockedAt)
        }
      }
      // 若线上无单位（仅 source 据点），按 source 是否被敌方占据判定
      if (unitsOnLine.length === 0) {
        const sourceCell = normalizeSupplyCellId(line.cellIds[0] ?? '')
        const occupier = world.units.find(
          (u) =>
            u.strength > 0 &&
            u.factionId !== line.factionId &&
            `${u.coord.col}:${u.coord.row}` === sourceCell,
        )
        connected = occupier === undefined
        if (!connected) blockedAtUi = toUiCellId(line.cellIds[0] ?? '')
      }

      // 路径摘要：转 UI 格式，过长截断（首尾 + …）
      const uiPath = line.cellIds.map(toUiCellId)
      const pathSummary =
        uiPath.length <= 6
          ? uiPath.join(' → ')
          : `${uiPath.slice(0, 3).join(' → ')} … ${uiPath.slice(-2).join(' → ')}`

      return {
        id: line.id,
        faction: faction ?? {
          id: line.factionId,
          name: line.factionId,
          color: '#888',
        } as Faction,
        typeName: LINE_TYPE_NAMES[line.type] ?? line.type,
        pathSummary,
        connected,
        blockedAtUi,
      }
    })

    // —— 低补给单位行 ——
    // 按 faction 分组调 computeSupplyConnectivity；列出 status 含 low_supply
    // 或 connectivity.connected===false 的单位（去重）。
    const lowSupplyRows: LowSupplyRow[] = []
    const factionIds = Array.from(new Set(world.units.map((u) => u.factionId)))
    for (const fid of factionIds) {
      const conn = hasNet
        ? computeSupplyConnectivity(map, world.units, fid)
        : new Map<string, { connected: boolean; blockedAt?: string }>()
      for (const u of world.units) {
        if (u.factionId !== fid || u.strength <= 0) continue
        const hasLowFlag = u.status.includes('low_supply')
        const c = conn.get(u.id)
        const severed = c?.connected === false
        if (!hasLowFlag && !severed) continue
        lowSupplyRows.push({
          unit: u,
          faction: factionById.get(fid) ?? ({ id: fid, name: fid, color: '#888' } as Faction),
          blockedAtUi: severed && c?.blockedAt !== undefined ? toUiCellId(c.blockedAt) : undefined,
          cellId: cellIdFromCoord(u.coord.col, u.coord.row),
          reason: severed ? 'severed' : 'flagged',
        })
      }
    }
    lowSupplyRows.sort((a, b) => (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0))

    // —— 补给源行 ——
    // isSupplySource=true 的 cell；所属阵营按其是否为某条 SupplyLine.cellIds[0] 判定。
    const sourceCells = map.cells.filter((c) => c.isSupplySource === true)
    const sourceByCellId = new Map<string, string>() // "col:row" → factionId
    for (const line of lines) {
      if (line.cellIds.length === 0) continue
      const src = normalizeSupplyCellId(line.cellIds[0])
      if (!sourceByCellId.has(src)) sourceByCellId.set(src, line.factionId)
    }
    const sourceRows: SourceRow[] = sourceCells.map((c) => {
      const key = `${c.col}:${c.row}`
      const fid = sourceByCellId.get(key)
      return {
        cellId: cellIdFromCoord(c.col, c.row),
        faction: fid !== undefined ? factionById.get(fid) : undefined,
      }
    })

    return { lineRows, lowSupplyRows, sourceRows, hasNetwork: hasNet }
  }, [context])

  // 未加载存档
  if (context === null) {
    return (
      <section className="panel supply-panel">
        <h2 className="panel__title">后勤</h2>
        <p className="supply-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  // 无补给网络（点状补给兼容）
  if (!hasNetwork) {
    return (
      <section className="panel supply-panel">
        <h2 className="panel__title">后勤</h2>
        <p className="supply-panel__empty">
          本战役未声明补给网络（点状补给），单位恒为连通状态。
        </p>
      </section>
    )
  }

  return (
    <section className="panel supply-panel">
      <h2 className="panel__title">后勤</h2>

      {/* —— 补给线列表 —— */}
      <div className="supply-panel__section">
        <h3 className="supply-panel__section-title">补给线</h3>
        {lineRows.length === 0 ? (
          <p className="supply-panel__muted">暂无补给线。</p>
        ) : (
          <ul className="supply-panel__lines">
            {lineRows.map((row) => (
              <li
                key={row.id}
                className={
                  'supply-panel__line' +
                  (row.connected ? '' : ' supply-panel__line--severed')
                }
              >
                <div className="supply-panel__line-head">
                  <span
                    className="supply-panel__faction-dot"
                    style={{ background: row.faction.color }}
                    aria-hidden
                  />
                  <span className="supply-panel__line-id">{row.id}</span>
                  <span className="supply-panel__line-type">{row.typeName}</span>
                  <span
                    className={
                      'supply-panel__line-status' +
                      (row.connected
                        ? ' supply-panel__line-status--ok'
                        : ' supply-panel__line-status--bad')
                    }
                  >
                    {row.connected ? '连通' : '切断'}
                    {!row.connected && row.blockedAtUi !== undefined && (
                      <span className="supply-panel__line-blocked">
                        {' '}@ {row.blockedAtUi}
                      </span>
                    )}
                  </span>
                </div>
                <div className="supply-panel__line-path" title={row.pathSummary}>
                  {row.pathSummary}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* —— 低补给单位 —— */}
      <div className="supply-panel__section">
        <h3 className="supply-panel__section-title">低补给单位</h3>
        {lowSupplyRows.length === 0 ? (
          <p className="supply-panel__muted">所有单位补给充足。</p>
        ) : (
          <ul className="supply-panel__low-list">
            {lowSupplyRows.map((row) => (
              <li key={row.unit.id} className="supply-panel__low-row">
                <span
                  className="supply-panel__faction-dot"
                  style={{ background: row.faction.color }}
                  aria-hidden
                />
                <span className="supply-panel__low-id">{row.unit.id}</span>
                <span className="supply-panel__low-type">
                  {UNIT_TYPE_NAMES[row.unit.type]}
                </span>
                <span className="supply-panel__low-cell">{row.cellId}</span>
                {row.reason === 'severed' ? (
                  <span className="supply-panel__low-tag supply-panel__low-tag--severed">
                    切断{row.blockedAtUi !== undefined ? ` @ ${row.blockedAtUi}` : ''}
                  </span>
                ) : (
                  <span className="supply-panel__low-tag supply-panel__low-tag--flagged">
                    低补给
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* —— 补给源 —— */}
      <div className="supply-panel__section">
        <h3 className="supply-panel__section-title">补给源</h3>
        {sourceRows.length === 0 ? (
          <p className="supply-panel__muted">无补给源据点。</p>
        ) : (
          <ul className="supply-panel__sources">
            {sourceRows.map((row, i) => (
              <li key={`${row.cellId}-${i}`} className="supply-panel__source-row">
                <span className="supply-panel__source-cell">{row.cellId}</span>
                {row.faction ? (
                  <>
                    <span
                      className="supply-panel__faction-dot"
                      style={{ background: row.faction.color }}
                      aria-hidden
                    />
                    <span className="supply-panel__source-faction">{row.faction.name}</span>
                  </>
                ) : (
                  <span className="supply-panel__muted">未归属</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

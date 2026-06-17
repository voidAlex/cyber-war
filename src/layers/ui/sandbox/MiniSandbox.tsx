/**
 * 缩略沙盘（MiniSandbox.tsx）— UI 重构第 1 批「全对话为主」。
 *
 * 右栏顶部的小型沙盘缩略图（约 200×150），用 CSS grid 模拟网格 + 单位色点 +
 * 选中单位高亮。非交互（仅点击弹全屏 SandboxOverlay）。
 *
 * 设计：
 * - 纯 DOM/CSS 渲染（无 PixiJS，轻量、首屏快、headless 友好）。
 * - 单位按阵营色（faction.color）画圆点；玩家选中单位加青光描边高亮。
 * - 玩家阵营（side=player）单位实心、敌方（enemy）半透明、盟友（ally）描边。
 * - 网格行/列自适应缩放，保持比例。
 * - 点击整个缩略图 → 触发 onOpen 全屏沙盘。
 *
 * 不 import @tauri-apps/api（UI 层）。
 *
 * @module layers/ui/sandbox/MiniSandbox
 */

import { useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import type { Unit } from '@/types'

/**
 * 缩略沙盘组件（右栏顶部）。
 *
 * @param onOpen 点击缩略图弹全屏沙盘的回调
 */
export default function MiniSandbox({ onOpen }: { onOpen: () => void }): JSX.Element {
  const context = useGameStore((s) => s.context)
  const selectedUnitId = useGameStore((s) => s.selectedUnitId)

  const world = context?.game.world
  const map = world?.map
  const units = useMemo(() => world?.units ?? [], [world])
  const factions = useMemo(() => world?.factions ?? [], [world])

  // 阵营 id → color 查表（单位色点染色用）
  const factionColor = useMemo(() => {
    const m: Record<string, string> = {}
    for (const f of factions) m[f.id] = f.color
    return m
  }, [factions])
  // 视角 bug 修复：玩家阵营 id——优先 world.playerFactionId（v0.2.2+ 权威），
  // fallback factions 中 side==='player'（旧存档；side swap 后亦正确）。
  const playerFactionId = world?.playerFactionId || factions.find((f) => f.side === 'player')?.id || ''
  // 阵营 id → 相对玩家阵营的关系分类（第 5 批多阵营支撑）。
  // 优先用 faction.relations[玩家阵营] 定性关系；缺失时回退 faction.side。
  // 分类：own（玩家阵营）/ enemy（交战/敌对）/ ally（结盟）/ neutral（中立/其他）。
  const factionSide = useMemo(() => {
    const m: Record<string, 'own' | 'enemy' | 'ally' | 'neutral'> = {}
    for (const f of factions) {
      if (f.id === playerFactionId) {
        m[f.id] = 'own'
        continue
      }
      // 优先用定性关系
      const rel = f.relations?.[playerFactionId]
      if (rel === 'at_war' || rel === 'hostile') {
        m[f.id] = 'enemy'
      } else if (rel === 'allied') {
        m[f.id] = 'ally'
      } else if (rel === 'neutral') {
        m[f.id] = 'neutral'
      } else {
        // 回退 side（旧存档/无 relations 字段）
        m[f.id] =
          f.side === 'enemy'
            ? 'enemy'
            : f.side === 'ally'
              ? 'ally'
              : f.side === 'player'
                ? 'own'
                : 'neutral'
      }
    }
    return m
  }, [factions, playerFactionId])

  const cols = map?.cols ?? 0
  const rows = map?.rows ?? 0

  // 第 3 批：cell 简化 tooltip 数据（坐标+地形+节点名）。
  // 缩略图非交互（点击弹全屏），故用原生 title 属性即可，无需 DOM 浮层。
  // 用 col,row 反查 map.cells（id 格式可能是 cell-{col}-{row} 或 col:row，col/row 比较更稳）。
  // 注意：useMemo 必须在 early return 之前调用（react-hooks/rules-of-hooks）。
  const cellMetaByCoord = useMemo(() => {
    const m: Record<string, { terrain: string; nodeName: string | null }> = {}
    if (!map) return m
    for (const c of map.cells) {
      m[`${c.col},${c.row}`] = {
        terrain: MINI_TERRAIN_NAMES[c.terrain] ?? c.terrain,
        nodeName: null,
      }
    }
    // 高价值节点名填入对应 cell
    for (const n of map.highValueNodes) {
      const nc = miniParseCellId(n.cellId)
      if (nc) {
        const key = `${nc.col},${nc.row}`
        if (m[key]) m[key].nodeName = n.name
      }
    }
    return m
  }, [map])

  // 无地图：占位提示（仍可点击弹全屏）
  if (cols === 0 || rows === 0) {
    return (
      <section className="panel mini-sandbox" aria-label="战场沙盘缩略图">
        <h2 className="panel__title">沙盘</h2>
        <button
          type="button"
          className="mini-sandbox__placeholder"
          onClick={onOpen}
          aria-label="打开全屏沙盘"
        >
          点击查看战场沙盘
        </button>
      </section>
    )
  }

  // 第 4 批：补给线简化版（缩略图仅画色线段，不画切断标记 ✕）。
  // 把 supplyNetwork.lines 的每个 cellId 归一为 "col,row"，记录阵营色：
  // 法军=青 #06B6D4，德军=灰 #6B7280。同 cell 多线时取首条（确定性）。
  // 渲染时在该 cell 画一条阵营色小横条（与单位圆点错位，不遮挡）。
  const supplyCellColor: Record<string, string> = {}
  const network = map?.supplyNetwork
  if (network) {
    for (const line of network.lines) {
      const color = line.factionId === 'france' ? '#06b6d4' : '#6b7280'
      for (const rawCellId of line.cellIds) {
        const c = miniParseCellId(rawCellId)
        if (c === null) continue
        const key = `${c.col},${c.row}`
        if (supplyCellColor[key] === undefined) supplyCellColor[key] = color
      }
    }
  }

  // 单位按 cell 聚合（同格多单位取首个代表点；缩略图不展开堆叠）
  const cellUnits: Record<string, Unit> = {}
  for (const u of units) {
    const key = `${u.coord.col},${u.coord.row}`
    if (cellUnits[key] === undefined) cellUnits[key] = u
  }

  // 列字母（0→A），缩略图坐标标签用
  const letter = (col: number): string => {
    let s = ''
    let n = col
    do {
      s = String.fromCharCode(65 + (n % 26)) + s
      n = Math.floor(n / 26) - 1
    } while (n >= 0)
    return s
  }

  return (
    <section className="panel mini-sandbox" aria-label="战场沙盘缩略图">
      <h2 className="panel__title">沙盘</h2>
      <button
        type="button"
        className="mini-sandbox__btn"
        onClick={onOpen}
        aria-label="点击放大查看全屏沙盘"
        title="点击放大"
      >
        <div
          className="mini-sandbox__grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            aspectRatio: `${cols} / ${rows}`,
          }}
        >
          {Array.from({ length: cols * rows }, (_, i) => {
            const col = i % cols
            const row = Math.floor(i / cols)
            const u = cellUnits[`${col},${row}`]
            const meta = cellMetaByCoord[`${col},${row}`]
            const supplyColor = supplyCellColor[`${col},${row}`]
            // 简化 tooltip：坐标 + 地形 + 节点名 + 单位 id（原生 title）
            const tipParts = [`${letter(col)}${row + 1}`]
            if (meta) {
              tipParts.push(meta.terrain)
              if (meta.nodeName) tipParts.push(meta.nodeName)
            }
            if (u) tipParts.push(u.id)
            const tip = tipParts.join(' · ')
            if (u === undefined) {
              // 第 4 批：补给线上的空 cell 画阵营色小横条（简化版，不画切断标记）
              return (
                <span key={i} className="mini-sandbox__cell" title={tip}>
                  {supplyColor !== undefined && (
                    <span
                      className="mini-sandbox__supply"
                      style={{ background: supplyColor }}
                      aria-hidden
                    />
                  )}
                </span>
              )
            }
            const color = factionColor[u.factionId] ?? '#06b6d4'
            const side = factionSide[u.factionId] ?? 'neutral'
            const selected = u.id === selectedUnitId
            return (
              <span key={i} className="mini-sandbox__cell" title={tip}>
                {supplyColor !== undefined && (
                  <span
                    className="mini-sandbox__supply"
                    style={{ background: supplyColor }}
                    aria-hidden
                  />
                )}
                <span
                  className={
                    'mini-sandbox__dot' +
                    (selected ? ' mini-sandbox__dot--selected' : '') +
                    (side === 'enemy' ? ' mini-sandbox__dot--enemy' : '') +
                    (side === 'ally' ? ' mini-sandbox__dot--ally' : '')
                  }
                  style={{ background: color, borderColor: color }}
                  title={tip}
                />
              </span>
            )
          })}
        </div>
        <span className="mini-sandbox__zoom-hint">⤢ 放大</span>
      </button>
    </section>
  )
}

/** 缩略图地形中文名（与 CellTooltip 的 TERRAIN_NAMES 同源，缩略图独立一份避免反向 import）。 */
const MINI_TERRAIN_NAMES: Record<string, string> = {
  plain: '平原',
  forest: '森林',
  mountain: '山地',
  water: '水域',
  urban: '城镇',
  fortress: '要塞',
  marsh: '沼泽',
}

/**
 * 解析节点 cellId（支持 cell-{col}-{row} / col:row / 字母+数字）为坐标，缩略图用。
 * 失败返回 null（不阻塞渲染，仅该格无节点名）。
 */
function miniParseCellId(cellId: string): { col: number; row: number } | null {
  const t = cellId.trim()
  const m1 = /^cell-(\d+)-(\d+)$/i.exec(t)
  if (m1) return { col: Number(m1[1]), row: Number(m1[2]) }
  const m2 = /^(\d+):(\d+)$/.exec(t)
  if (m2) return { col: Number(m2[1]), row: Number(m2[2]) }
  // 字母+数字（C3）
  const m3 = /^([A-Za-z]+)(\d+)$/.exec(t)
  if (m3) {
    const upper = m3[1].toUpperCase()
    let col = 0
    for (let i = 0; i < upper.length; i++) {
      col = col * 26 + (upper.charCodeAt(i) - 65) + 1
    }
    return { col: col - 1, row: Number(m3[2]) - 1 }
  }
  return null
}

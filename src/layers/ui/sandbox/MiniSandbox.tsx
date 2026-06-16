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
  // 阵营 id → side 查表（实心/半透明/描边区分）
  const factionSide = useMemo(() => {
    const m: Record<string, string> = {}
    for (const f of factions) m[f.id] = f.side
    return m
  }, [factions])

  const cols = map?.cols ?? 0
  const rows = map?.rows ?? 0

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

  // 单位按 cell 聚合（同格多单位取首个代表点；缩略图不展开堆叠）
  const cellUnits: Record<string, Unit> = {}
  for (const u of units) {
    const key = `${u.coord.col},${u.coord.row}`
    if (cellUnits[key] === undefined) cellUnits[key] = u
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
            if (u === undefined) {
              return <span key={i} className="mini-sandbox__cell" />
            }
            const color = factionColor[u.factionId] ?? '#06b6d4'
            const side = factionSide[u.factionId] ?? 'neutral'
            const selected = u.id === selectedUnitId
            return (
              <span key={i} className="mini-sandbox__cell">
                <span
                  className={
                    'mini-sandbox__dot' +
                    (selected ? ' mini-sandbox__dot--selected' : '') +
                    (side === 'enemy' ? ' mini-sandbox__dot--enemy' : '') +
                    (side === 'ally' ? ' mini-sandbox__dot--ally' : '')
                  }
                  style={{ background: color, borderColor: color }}
                  title={u.id}
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

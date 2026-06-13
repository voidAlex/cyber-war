/**
 * 沙盘 React 组件（Sandbox.tsx）— PixiJS 8 + React 19。
 *
 * 职责：
 * - useEffect 创建 PIXI.Application，把 canvas 挂载到容器 ref。
 * - 把 SandboxRenderer.root 加入 app.stage，并把舞台交互事件桥接到
 *   renderer.handleStagePointer（命中 cell → onCellClick）。
 * - 订阅 zustand store：context.game.world（map/units/factions）+
 *   context.pendingOrders（预演路径）。worldState 变化时调 renderer 增量重绘。
 * - ResizeObserver 监听容器尺寸，resize PIXI Application（resizeTo + 手动 setSize）。
 * - 组件卸载：renderer.destroy + app.destroy（释放 WebGL 上下文）。
 *
 * 设计约束：
 * - 纯 PixiJS 渲染（SandboxRenderer），不用 @pixi/react、不用 Konva。
 * - worldState 变化驱动重绘（非每帧全量），PIXI ticker 60fps 只驱动 GPU。
 * - 空 worldState（未加载存档）渲染占位空沙盘，不崩。
 *
 * @module layers/ui/sandbox/Sandbox
 */

import { useEffect, useRef } from 'react'
import { type JSX } from 'react'
import { Application, Rectangle, FederatedPointerEvent } from 'pixi.js'
import { useGameStore } from '@/store/game-store'
import type { ActionEnvelope, Faction, GameMap, Unit } from '@/types'
import {
  SandboxRenderer,
  type SandboxWorld,
} from './SandboxRenderer'
import { CELL_SIZE, gridPixelSize } from './coords'
import type { CSSProperties } from 'react'

/** 容器最小尺寸（避免 0×0 时 PixiJS 报错）。 */
const MIN_SIZE = 64

/** 沙盘 panel 内联样式（独立于全局样式表，保证有尺寸）。 */
const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 320,
  minHeight: 360,
  flex: '1 1 auto',
}

/** canvas 挂载点内联样式：撑满 panel 剩余空间，给 PIXI resize 提供真实尺寸。 */
const canvasHostStyle: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 280,
  width: '100%',
  overflow: 'hidden',
  background: '#1a1d21',
}

/**
 * 沙盘组件。
 *
 * 不接受 props（数据来自 store）；onCellClick 回调当前接 console，
 * M2 后续命令握手接入 store 后替换为正式回调。
 */
export default function Sandbox(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    // —— 1. 创建 PIXI Application ——
    // PixiJS 8：new Application() 不再在构造里 init，需 await app.init()。
    let disposed = false
    let app: Application | null = null
    const renderer = new SandboxRenderer({
      onCellClick: (cellId) => {
        // M2：先 console，后续接命令握手 store
        // eslint-disable-next-line no-console
        console.log('[sandbox] cell clicked:', cellId)
      },
    })

    /**
     * 把当前 worldState + pendingOrders 推给 renderer 重绘。
     * 在 effect 闭包里捕获最新的 store 快照（避免重建 Application）。
     */
    const syncFromStore = (
      map: GameMap | undefined,
      units: Unit[],
      factions: Faction[],
      pendingOrders: ActionEnvelope[],
    ): void => {
      const world: SandboxWorld | null =
        map === undefined ? null : { map, units, factions }
      renderer.updateWorld(world)
      renderer.updatePreview(pendingOrders)
    }

    /**
     * 同步 Application 画布尺寸到容器（含 ResizeObserver 调用）。
     * 居中：renderer.root.x/y 设为剩余空间的一半。
     */
    const resizeToContainer = (cols: number, rows: number): void => {
      if (app === null || disposed) return
      const rect = container.getBoundingClientRect()
      const w = Math.max(MIN_SIZE, Math.floor(rect.width))
      const h = Math.max(MIN_SIZE, Math.floor(rect.height))
      app.renderer.resize(w, h)
      const { width, height } = gridPixelSize(cols, rows)
      // 网格居中（若网格小于画布）；否则从 (0,0) 起（PixiJS 自动裁剪可见区）
      renderer.root.x = Math.max(0, (w - width) / 2)
      renderer.root.y = Math.max(0, (h - height) / 2)
    }

    /**
     * 初始化 Application（异步），完成后挂 stage 交互 + 首次同步 store。
     */
    void (async () => {
      app = new Application()
      await app.init({
        background: 0x1a1d21,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        width: MIN_SIZE,
        height: MIN_SIZE,
      })
      if (disposed) {
        // 组件在 await 期间已卸载：立即销毁新建的 app，避免泄漏
        app.destroy(true, { children: true })
        app = null
        return
      }

      // canvas 挂载 + 渲染层加入 stage
      app.canvas.style.display = 'block'
      app.canvas.style.width = '100%'
      app.canvas.style.height = '100%'
      container.appendChild(app.canvas)
      app.stage.addChild(renderer.root)

      // 交互：root 整个矩形命中，事件转交 renderer 命中 cell
      renderer.root.eventMode = 'static'
      renderer.root.hitArea = new Rectangle(
        0,
        0,
        gridPixelSize(0, 0).width,
        gridPixelSize(0, 0).height,
      )
      const onPointerDown = (e: FederatedPointerEvent): void => {
        const ctx = useGameStore.getState().context
        const map = ctx?.game.world.map
        if (map === undefined) return
        const local = renderer.root.toLocal(e.global)
        renderer.handleStagePointer(
          local.x,
          local.y,
          'click',
          map.cols,
          map.rows,
        )
      }
      const onPointerMove = (e: FederatedPointerEvent): void => {
        const ctx = useGameStore.getState().context
        const map = ctx?.game.world.map
        if (map === undefined) return
        const local = renderer.root.toLocal(e.global)
        renderer.handleStagePointer(
          local.x,
          local.y,
          'move',
          map.cols,
          map.rows,
        )
      }
      renderer.root.on('pointerdown', onPointerDown)
      renderer.root.on('pointermove', onPointerMove)

      // 首次同步（用当前 store 状态）+ 首次 resize + hitArea 校正
      const initialCtx = useGameStore.getState().context
      const initialMap = initialCtx?.game.world.map
      syncFromStore(
        initialMap,
        initialCtx?.game.world.units ?? [],
        initialCtx?.game.world.factions ?? [],
        initialCtx?.pendingOrders ?? [],
      )
      if (initialMap !== undefined) {
        resizeToContainer(initialMap.cols, initialMap.rows)
        renderer.root.hitArea = new Rectangle(
          0,
          0,
          initialMap.cols * CELL_SIZE,
          initialMap.rows * CELL_SIZE,
        )
      } else {
        resizeToContainer(1, 1)
      }
    })()

    // —— 2. store 订阅：worldState / pendingOrders 变化时增量重绘 ——
    const unsubscribe = useGameStore.subscribe((state, prev) => {
      if (app === null || disposed) return
      const ctx = state.context
      const prevCtx = prev.context
      const world = ctx?.game.world
      const prevWorld = prevCtx?.game.world
      const worldChanged = world !== prevWorld
      const ordersChanged = ctx?.pendingOrders !== prevCtx?.pendingOrders
      if (!worldChanged && !ordersChanged) return

      const map = world?.map
      syncFromStore(
        map,
        world?.units ?? [],
        world?.factions ?? [],
        ctx?.pendingOrders ?? [],
      )
      // 网格尺寸可能变（换存档/换战役），重算 hitArea + 居中
      if (map !== undefined) {
        renderer.root.hitArea = new Rectangle(
          0,
          0,
          map.cols * CELL_SIZE,
          map.rows * CELL_SIZE,
        )
        resizeToContainer(map.cols, map.rows)
      }
    })

    // —— 3. ResizeObserver：容器尺寸变化时重算居中 ——
    const ro = new ResizeObserver(() => {
      if (app === null || disposed) return
      const ctx = useGameStore.getState().context
      const map = ctx?.game.world.map
      resizeToContainer(map?.cols ?? 1, map?.rows ?? 1)
    })
    ro.observe(container)

    // —— 4. 卸载清理 ——
    return () => {
      disposed = true
      ro.disconnect()
      unsubscribe()
      renderer.destroy()
      if (app !== null) {
        app.destroy(true, { children: true })
        app = null
      }
    }
  }, [])

  return (
    <section className="panel sandbox" style={panelStyle}>
      <h2 className="panel__title">战场沙盘</h2>
      {/*
        PixiJS canvas 挂载点。容器需有明确尺寸，PIXI 才能据此 resize。
        用内联样式给定最小高度，避免依赖尚未接入的全局样式表；
        外部仍可通过 .sandbox__canvas-host 覆盖（width/height 可被 CSS 覆写）。
      */}
      <div ref={containerRef} className="sandbox__canvas-host" style={canvasHostStyle} />
    </section>
  )
}

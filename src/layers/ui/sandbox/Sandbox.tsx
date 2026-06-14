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
 * - **不 import @tauri-apps/api**（gateway 层唯一）。
 *
 * 健壮性（agent-browser headless / StrictMode 双调用友好）：
 * - async init 用 try/catch 包裹，失败 console.error + 降级占位（不挂 canvas）。
 * - destroy 前 init 完成 flag 检查；destroy 本身 try/catch，绝不在 effect cleanup 抛错
 *   （React 会把 cleanup 抛错传播到整棵树，导致主界面其余面板全被卸载）。
 * - 所有 store 链式访问全程 optional chain（context 可能为 null、intel.decayRule 可能缺）。
 *
 * @module layers/ui/sandbox/Sandbox
 */

import { useEffect, useRef, useState } from 'react'
import { type JSX } from 'react'
import { Application, Rectangle, FederatedPointerEvent } from 'pixi.js'
import { useGameStore } from '@/store/game-store'
import type { ActionEnvelope, Faction, GameMap, Unit } from '@/types'
import type { StateMachineContext } from '@/layers/application/state-machine/types'
import {
  SandboxRenderer,
  type SandboxWorld,
} from './SandboxRenderer'
import { CELL_SIZE, gridPixelSize } from './coords'
import { getPlayerFactionId } from './intel-visibility'
import type { CSSProperties } from 'react'

/** 容器最小尺寸（避免 0×0 时 PixiJS 报错）。 */
const MIN_SIZE = 64

/** 默认情报半衰回合数（store 无 world.intel 时的兜底）。 */
const DEFAULT_HALF_LIFE_TURNS = 3

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

/** 降级占位内联样式（init 失败时显示，保证沙盘区有可见内容）。 */
const degradedStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '1 1 auto',
  minHeight: 280,
  padding: 24,
  color: '#a0a4a8',
  border: '1px dashed #3a3d41',
  borderRadius: 4,
  textAlign: 'center',
}

/**
 * 安全读取情报半衰回合数。
 *
 * 处理 context 可能为 null、world 可能没有 intel.decayRule 的情况。
 * 全程 optional chain + 默认值兜底，绝不在访问链上抛 TypeError。
 *
 * @param ctx store context（可能为 null）
 * @returns 半衰回合数，缺省 3
 */
function safeHalfLifeTurns(ctx: StateMachineContext | null): number {
  const halfLife = ctx?.game.world.intel?.decayRule?.halfLifeTurns
  if (typeof halfLife === 'number' && Number.isFinite(halfLife) && halfLife > 0) {
    return halfLife
  }
  return DEFAULT_HALF_LIFE_TURNS
}

/**
 * 沙盘组件。
 *
 * 不接受 props（数据来自 store）；onCellClick 回调当前接 console，
 * M2 后续命令握手接入 store 后替换为正式回调。
 *
 * 内部 initFailed state：async init 抛错时置 true，渲染降级占位而非 canvas。
 * 这与外层 SandboxErrorBoundary 互为兜底（boundary 处理渲染期同步抛错）。
 */
export default function Sandbox(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** async init 是否失败（失败则渲染降级占位）。 */
  const [initFailed, setInitFailed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    // —— 1. 创建 PIXI Application ——
    // PixiJS 8：new Application() 不再在构造里 init，需 await app.init()。
    let disposed = false
    let app: Application | null = null
    /** app.init() 是否完成（未完成时 destroy 会因内部方法未挂载而抛错）。 */
    let initDone = false
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
      currentTurn: number,
      halfLifeTurns: number,
    ): void => {
      const observerFactionId = getPlayerFactionId(factions)
      const world: SandboxWorld | null =
        map === undefined ? null : { map, units, factions, observerFactionId, currentTurn, halfLifeTurns }
      renderer.updateWorld(world)
      renderer.updatePreview(pendingOrders)
    }

    /**
     * 同步 Application 画布尺寸到容器（含 ResizeObserver 调用）。
     * 居中：renderer.root.x/y 设为剩余空间的一半。
     */
    const resizeToContainer = (cols: number, rows: number): void => {
      if (app === null || disposed || !initDone) return
      const rect = container.getBoundingClientRect()
      const w = Math.max(MIN_SIZE, Math.floor(rect.width))
      const h = Math.max(MIN_SIZE, Math.floor(rect.height))
      try {
        app.renderer.resize(w, h)
      } catch (err) {
        // resize 偶发失败不应传播到 React（如 WebGL 上下文丢失）
        // eslint-disable-next-line no-console
        console.error('[sandbox] renderer.resize failed:', err)
        return
      }
      const { width, height } = gridPixelSize(cols, rows)
      // 网格居中（若网格小于画布）；否则从 (0,0) 起（PixiJS 自动裁剪可见区）
      renderer.root.x = Math.max(0, (w - width) / 2)
      renderer.root.y = Math.max(0, (h - height) / 2)
    }

    /**
     * 初始化 Application（异步），完成后挂 stage 交互 + 首次同步 store。
     *
     * 整段 try/catch：任何 init 期错误（WebGL 不可用、headless 环境限制、
     * WebGL 上下文数超限等）都不传播，降级为 console.error + 占位 UI。
     */
    void (async () => {
      try {
        app = new Application()
        await app.init({
          background: 0x1a1d21,
          antialias: true,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
          width: MIN_SIZE,
          height: MIN_SIZE,
          // headless / WebGL 不可用时，allowWebGL 失败会自动 fallback canvas，
          // 若仍失败由外层 try/catch 捕获并降级。
        })
        if (disposed) {
          // 组件在 await 期间已卸载：立即销毁新建的 app，避免泄漏
          // 此时 init 已完成，destroy 安全
          app.destroy(true, { children: true })
          app = null
          return
        }
        // 标记 init 完成 —— 后续 destroy / resize 才安全
        initDone = true

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
          initialCtx?.game.world.turnIndex ?? 0,
          safeHalfLifeTurns(initialCtx),
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
      } catch (err) {
        // init 失败：标记降级，绝不传播到 React（否则主界面全崩）
        // eslint-disable-next-line no-console
        console.error('[sandbox] PIXI Application init failed, degrading:', err)
        // 清理已创建但未完成 init 的 app（destroy 也 try/catch，防 _cancelResize 类问题）
        if (app !== null) {
          try {
            app.destroy(true, { children: true })
          } catch {
            // 忽略：app 可能处于半初始化状态
          }
          app = null
        }
        if (!disposed) {
          setInitFailed(true)
        }
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
        world?.turnIndex ?? 0,
        // intel.decayRule 全程 optional chain，context 可能为 null
        safeHalfLifeTurns(ctx ?? null),
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
    // 关键：cleanup 中绝不抛错。React 会把 passive effect cleanup 的抛错
    // 传播到整棵树，导致主界面其余面板全部被卸载。所有销毁操作 try/catch。
    return () => {
      disposed = true
      try {
        ro.disconnect()
      } catch {
        // 忽略
      }
      try {
        unsubscribe()
      } catch {
        // 忽略
      }
      try {
        renderer.destroy()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[sandbox] renderer.destroy failed:', err)
      }
      // app.destroy 仅在 init 完成后才安全（_cancelResize 等内部方法已挂载）。
      // StrictMode 双调用时，第一次 cleanup 可能发生在 init 完成之前，
      // 此时 destroy 会抛 TypeError，必须跳过。
      if (app !== null) {
        if (initDone) {
          try {
            app.destroy(true, { children: true })
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[sandbox] app.destroy failed:', err)
          }
        } else {
          // init 未完成：app 处于半初始化状态，destroy 不安全；
          // 尝试停止 ticker（如果存在）后放弃，由浏览器 GC 回收。
          try {
            app.destroy()
          } catch {
            // 忽略：接受可能的微小资源泄漏（半初始化 app 无 canvas/renderer 可销毁）
          }
        }
        app = null
      }
    }
  }, [])

  // 降级占位（async init 失败）：显示提示，绝不挂 canvas
  if (initFailed) {
    return (
      <section className="panel sandbox sandbox--degraded" style={panelStyle}>
        <h2 className="panel__title">战场沙盘</h2>
        <div style={degradedStyle}>
          <p style={{ fontSize: 14 }}>沙盘加载失败</p>
          <p style={{ fontSize: 11, marginTop: 8, opacity: 0.7 }}>
            WebGL 渲染不可用或初始化失败。其余面板不受影响，可继续指挥。
          </p>
        </div>
      </section>
    )
  }

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

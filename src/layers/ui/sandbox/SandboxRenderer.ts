/**
 * 沙盘渲染器（SandboxRenderer）— 纯 PixiJS 8 渲染逻辑（非 React）。
 *
 * 职责：把 WorldState（map/units/factions）+ pendingOrders（预演路径）
 * 重绘到 PIXI stage。分层 Container：
 *
 *   stage
 *   ├── gridLayer       地形底色 + 网格线 + 坐标标签
 *   ├── objectiveLayer  高价值节点星标/方框
 *   ├── previewLayer    pendingOrders move/capture 虚线预演
 *   ├── unitLayer       单位军标（阵营色矩形/圆形）+ 强度条
 *   └── highlightLayer  选中/悬停 cell 高亮（最上层，交互最直观）
 *
 * 性能：
 * - 不在 ticker 每帧全量重绘。PIXI ticker 仅驱动 GPU 渲染（60fps），
 *   业务图层只在 worldState/pendingOrders 变化时调用 redraw*（增量：先
 *   clear 再重画当前层，避免遗留残影，复杂度 O(cells+units+orders)）。
 * - 每层独立 Container，互不重建，层内 Graphics.clear() 后重画。
 *
 * 对接 store：本类不直接 import store；由 Sandbox.tsx 订阅 store 后
 * 调用 renderer.updateWorld(world)/updatePreview(orders)/setSelected(...)。
 *
 * @module layers/ui/sandbox/SandboxRenderer
 */

import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type {
  ActionEnvelope,
  Faction,
  GameMap,
  Unit,
} from '@/types'
import {
  CELL_SIZE,
  cellCenter,
  cellToPixel,
  colToLetter,
  pixelToCell,
} from './coords'
import {
  extractTargetCoord,
  extractUnitId,
  isMoveLikeOrder,
} from './payload'
import {
  GRID_LINE_ALPHA,
  GRID_LINE_COLOR,
  GRID_LINE_WIDTH,
  HIGHLIGHT_ALPHA,
  HIGHLIGHT_STROKE_ALPHA,
  HOVER_COLOR,
  LABEL_ALPHA,
  LABEL_COLOR,
  OBJECTIVE_ALPHA,
  OBJECTIVE_BORDER_COLOR,
  OBJECTIVE_COLOR,
  PREVIEW_DASH_LENGTH,
  PREVIEW_GAP_LENGTH,
  PREVIEW_LINE_ALPHA,
  PREVIEW_LINE_COLOR,
  PREVIEW_LINE_WIDTH,
  SELECTED_COLOR,
  STRENGTH_BAR_BG,
  STRENGTH_COLOR_HIGH,
  STRENGTH_COLOR_LOW,
  TERRAIN_COLORS,
  TERRAIN_FALLBACK_COLOR,
  UNIT_BORDER_COLOR,
  UNIT_BORDER_WIDTH,
  factionColorToNumber,
} from './theme'

/** 沙盘交互回调集合（由 Sandbox.tsx 注入，渲染层不持有 store）。 */
export interface SandboxCallbacks {
  /** 点击某 cell（cellId 如 "C3"）。 */
  onCellClick?: (cellId: string) => void
}

/** updateWorld 入参：worldState 的渲染相关子集。 */
export interface SandboxWorld {
  map: GameMap
  units: Unit[]
  factions: Faction[]
}

/**
 * 单个单位的位置查表 key（用于增量时避免重复绘制同一单位）。
 * M2 直接 clear+重画全单位层（单位数量级 < 几百，O(units) 可接受）。
 */
function unitKey(u: Unit): string {
  return u.id
}

/**
 * 沙盘渲染器类（纯 PixiJS）。
 *
 * 生命周期：构造 → attach 到 PIXI Application.stage → 多次 update/redraw
 * → detach（destroy，由 Sandbox.tsx 在组件卸载时调用 app.destroy 一并清理）。
 */
export class SandboxRenderer {
  /** 根容器（已 addChild 到 application.stage）。 */
  readonly root: Container

  private readonly gridLayer = new Container()
  private readonly objectiveLayer = new Container()
  private readonly previewLayer = new Container()
  private readonly unitLayer = new Container()
  private readonly highlightLayer = new Container()

  /** 单 Graphics 承载地形底色+网格线（频繁 clear，单对象省内存）。 */
  private readonly terrainGraphics = new Graphics()
  private readonly gridLineGraphics = new Graphics()
  private readonly objectiveGraphics = new Graphics()
  private readonly previewGraphics = new Graphics()
  private readonly unitGraphics = new Graphics()
  private readonly highlightGraphics = new Graphics()

  /** 坐标标签独立 Text 集合（clear 时一并 destroy 释放纹理）。 */
  private labels: Text[] = []

  /** 当前世界快照（updateWorld 写入，redraw 读取）。 */
  private world: SandboxWorld | null = null
  /** 当前预演订单（updatePreview 写入）。 */
  private pendingOrders: ActionEnvelope[] = []

  private selected: { col: number; row: number } | null = null
  private hover: { col: number; row: number } | null = null

  private readonly callbacks: SandboxCallbacks

  /** 标签文本样式（构造时一次，避免每 cell 重建 TextStyle）。 */
  private readonly labelStyle: TextStyle

  constructor(callbacks: SandboxCallbacks = {}) {
    this.callbacks = callbacks
    this.root = new Container()
    this.root.label = 'sandbox-root'

    // 分层按从底到顶 add（后加的在上）
    this.gridLayer.label = 'grid'
    this.objectiveLayer.label = 'objective'
    this.previewLayer.label = 'preview'
    this.unitLayer.label = 'unit'
    this.highlightLayer.label = 'highlight'

    this.gridLayer.addChild(this.terrainGraphics, this.gridLineGraphics)
    this.objectiveLayer.addChild(this.objectiveGraphics)
    this.previewLayer.addChild(this.previewGraphics)
    this.unitLayer.addChild(this.unitGraphics)
    this.highlightLayer.addChild(this.highlightGraphics)

    this.root.addChild(
      this.gridLayer,
      this.objectiveLayer,
      this.previewLayer,
      this.unitLayer,
      this.highlightLayer,
    )

    this.labelStyle = new TextStyle({
      fontFamily: 'monospace',
      fontSize: 10,
      fill: LABEL_COLOR,
    })
  }

  /** 注入/更新交互回调（运行时可替换）。 */
  setCallbacks(cb: SandboxCallbacks): void {
    Object.assign(this.callbacks, cb)
  }

  /** 写入新世界状态并触发地图层+目标层+单位层重绘。 */
  updateWorld(world: SandboxWorld | null): void {
    this.world = world
    this.redrawGrid()
    this.redrawObjectives()
    this.redrawUnits()
    this.redrawHighlight()
  }

  /** 写入预演订单并重绘预演层。 */
  updatePreview(orders: ActionEnvelope[]): void {
    this.pendingOrders = orders
    this.redrawPreview()
  }

  /** 设置选中 cell（null 清除），触发高亮重绘。 */
  setSelected(coord: { col: number; row: number } | null): void {
    this.selected = coord
    this.redrawHighlight()
  }

  /** 设置悬停 cell（null 清除），触发高亮重绘。 */
  setHover(coord: { col: number; row: number } | null): void {
    this.hover = coord
    this.redrawHighlight()
  }

  /**
   * 处理一次 stage 坐标系下的点击/移动事件。
   *
   * Sandbox.tsx 在 PIXI stage 交互回调中调用此方法（传入相对 stage 的
   * 像素坐标）。命中 cell 时回调 onCellClick 并设选中。
   */
  handleStagePointer(
    x: number,
    y: number,
    mode: 'click' | 'move',
    cols: number,
    rows: number,
  ): void {
    const cell = pixelToCell(x, y, cols, rows)
    if (mode === 'move') {
      this.setHover(cell)
      return
    }
    // click
    if (cell === null) {
      this.setSelected(null)
      return
    }
    this.setSelected(cell)
    const cellId = `${colToLetter(cell.col)}${cell.row + 1}`
    this.callbacks.onCellClick?.(cellId)
  }

  // ===== 分层重绘 =====

  /** 重绘地形底色 + 网格线 + 坐标标签。 */
  private redrawGrid(): void {
    const g = this.terrainGraphics
    const lines = this.gridLineGraphics
    g.clear()
    lines.clear()
    // 清理旧标签 Text（释放纹理）
    for (const t of this.labels) {
      this.gridLayer.removeChild(t)
      t.destroy()
    }
    this.labels = []

    const map = this.world?.map
    if (map === undefined || map.cells.length === 0) {
      // 空沙盘占位：画 1 个灰色 cell 提示「未加载存档」
      g.rect(0, 0, CELL_SIZE, CELL_SIZE).fill({ color: TERRAIN_FALLBACK_COLOR })
      lines
        .rect(0, 0, CELL_SIZE, CELL_SIZE)
        .stroke({ color: GRID_LINE_COLOR, width: GRID_LINE_WIDTH, alpha: GRID_LINE_ALPHA })
      const placeholder = new Text({
        text: '空沙盘',
        style: new TextStyle({ fontFamily: 'monospace', fontSize: 12, fill: LABEL_COLOR }),
      })
      placeholder.anchor.set(0.5)
      placeholder.x = CELL_SIZE / 2
      placeholder.y = CELL_SIZE / 2
      placeholder.alpha = LABEL_ALPHA
      this.gridLayer.addChild(placeholder)
      this.labels.push(placeholder)
      return
    }

    // 地形底色（按 cell.terrain 着色）
    for (const cell of map.cells) {
      const { x, y } = cellToPixel(cell.col, cell.row)
      const color = TERRAIN_COLORS[cell.terrain] ?? TERRAIN_FALLBACK_COLOR
      g.rect(x, y, CELL_SIZE, CELL_SIZE).fill({ color })
    }

    // 网格线（一次性 stroke，性能优于每 cell 单独画）
    const { cols, rows } = map
    for (let c = 0; c <= cols; c++) {
      const x = c * CELL_SIZE
      lines
        .moveTo(x, 0)
        .lineTo(x, rows * CELL_SIZE)
        .stroke({ color: GRID_LINE_COLOR, width: GRID_LINE_WIDTH, alpha: GRID_LINE_ALPHA })
    }
    for (let r = 0; r <= rows; r++) {
      const y = r * CELL_SIZE
      lines
        .moveTo(0, y)
        .lineTo(cols * CELL_SIZE, y)
        .stroke({ color: GRID_LINE_COLOR, width: GRID_LINE_WIDTH, alpha: GRID_LINE_ALPHA })
    }

    // 坐标标签：列字母在顶部、行号在左侧（每行/列各一个，避免每 cell 都画）
    for (let c = 0; c < cols; c++) {
      const t = new Text({
        text: colToLetter(c),
        style: this.labelStyle,
      })
      t.anchor.set(0.5, 0)
      t.x = c * CELL_SIZE + CELL_SIZE / 2
      t.y = 2
      t.alpha = LABEL_ALPHA
      this.gridLayer.addChild(t)
      this.labels.push(t)
    }
    for (let r = 0; r < rows; r++) {
      const t = new Text({
        text: String(r + 1),
        style: this.labelStyle,
      })
      t.anchor.set(0, 0.5)
      t.x = 3
      t.y = r * CELL_SIZE + CELL_SIZE / 2
      t.alpha = LABEL_ALPHA
      this.gridLayer.addChild(t)
      this.labels.push(t)
    }
  }

  /** 重绘高价值节点星标（isObjective 或在 highValueNodes 中的 cell）。 */
  private redrawObjectives(): void {
    const g = this.objectiveGraphics
    g.clear()

    const map = this.world?.map
    if (map === undefined || map.cells.length === 0) return

    // 高价值节点 cellId 集合（highValueNodes 显式登记的）
    const explicitCellIds = new Set(map.highValueNodes.map((n) => n.cellId))

    for (const cell of map.cells) {
      const isObj = cell.isObjective || explicitCellIds.has(cell.id)
      if (!isObj) continue
      const { x, y } = cellCenter(cell.col, cell.row)
      // 外框方框（金色描边）
      const half = CELL_SIZE / 2 - 3
      g.rect(x - half, y - half, half * 2, half * 2).stroke({
        color: OBJECTIVE_BORDER_COLOR,
        width: 2,
        alpha: OBJECTIVE_ALPHA,
      })
      // 内嵌五角星近似（用 4 个三角拼出星形太复杂，M2 用实心菱形代替星标，
      // 视觉上同样醒目；后续 M3 可换 Sprite 星标）
      g.moveTo(x, y - half + 5)
      g.lineTo(x + half - 5, y)
      g.lineTo(x, y + half - 5)
      g.lineTo(x - half + 5, y)
      g.lineTo(x, y - half + 5)
      g.fill({ color: OBJECTIVE_COLOR, alpha: OBJECTIVE_ALPHA })
    }
  }

  /** 重绘预演虚线：每条 move/capture 订单从单位当前 coord 到 targetCoord。 */
  private redrawPreview(): void {
    const g = this.previewGraphics
    g.clear()

    const units = this.world?.units
    if (units === undefined || this.pendingOrders.length === 0) return

    const unitById = new Map<string, Unit>()
    for (const u of units) unitById.set(u.id, u)

    for (const order of this.pendingOrders) {
      // 只画 move/capture 类（payload.kind 或顶层 intent 含 move/capture 关键词）
      if (!isMoveLikeOrder(order)) continue
      // payload 里找 unitId（宽容命名，由 payload.extractUnitId 处理）
      const unitId = extractUnitId(order.payload)
      if (unitId === null) continue
      const unit = unitById.get(unitId)
      if (unit === undefined) continue
      const target = extractTargetCoord(order.payload)
      if (target === null) continue

      const from = cellCenter(unit.coord.col, unit.coord.row)
      const to = cellCenter(target.col, target.row)
      drawDashedLine(
        g,
        from.x,
        from.y,
        to.x,
        to.y,
        PREVIEW_DASH_LENGTH,
        PREVIEW_GAP_LENGTH,
        PREVIEW_LINE_COLOR,
        PREVIEW_LINE_WIDTH,
        PREVIEW_LINE_ALPHA,
      )
      // 终点小圆点（目标标记）
      g.circle(to.x, to.y, 4).fill({
        color: PREVIEW_LINE_COLOR,
        alpha: PREVIEW_LINE_ALPHA,
      })
    }
  }

  /** 重绘单位军标 + 强度条。 */
  private redrawUnits(): void {
    const g = this.unitGraphics
    g.clear()

    const world = this.world
    if (world === null) return
    const { units, factions } = world
    const factionById = new Map<string, Faction>()
    for (const f of factions) factionById.set(f.id, f)

    for (const unit of units) {
      const faction = factionById.get(unit.factionId)
      const fill = factionColorToNumber(faction?.color)
      const { x, y } = cellCenter(unit.coord.col, unit.coord.row)
      // 军标形状按 type 区分：装甲/炮兵用矩形，其余用圆形（M2 简易区分）
      const half = CELL_SIZE / 2 - 6
      if (unit.type === 'armor' || unit.type === 'artillery') {
        g.rect(x - half, y - half, half * 2, half * 2)
          .fill({ color: fill })
          .stroke({ color: UNIT_BORDER_COLOR, width: UNIT_BORDER_WIDTH })
      } else {
        g.circle(x, y, half)
          .fill({ color: fill })
          .stroke({ color: UNIT_BORDER_COLOR, width: UNIT_BORDER_WIDTH })
      }

      // 强度条（单位下方）：背景 + 前景按 strength 比例
      const ratio = clamp01(unit.strength / 100)
      const barW = half * 2
      const barH = 3
      const barX = x - half
      const barY = y + half + 2
      g.rect(barX, barY, barW, barH).fill({ color: STRENGTH_BAR_BG })
      const fgColor = ratio > 0.5 ? STRENGTH_COLOR_HIGH : STRENGTH_COLOR_LOW
      g.rect(barX, barY, barW * ratio, barH).fill({ color: fgColor })

      // 诱饵/欺骗单位加虚线外框标记（M2 提示，情报规则在 M4 细化）
      if (unit.deception === true) {
        drawDashedLine(
          g,
          x - half - 1,
          y - half - 1,
          x + half + 1,
          y - half - 1,
          3,
          2,
          0xffffff,
          1,
          0.8,
        )
      }

      void unitKey // 保留 key 函数引用（M2 全量重画，预留增量优化）
    }
  }

  /** 重绘高亮层（选中/悬停）。 */
  private redrawHighlight(): void {
    const g = this.highlightGraphics
    g.clear()
    const map = this.world?.map
    if (map === undefined || map.cells.length === 0) return

    // 悬停（半透明白填充 + 描边）
    if (this.hover !== null && inBounds(this.hover, map.cols, map.rows)) {
      const { x, y } = cellToPixel(this.hover.col, this.hover.row)
      g.rect(x, y, CELL_SIZE, CELL_SIZE)
        .fill({ color: HOVER_COLOR, alpha: HIGHLIGHT_ALPHA })
        .stroke({ color: HOVER_COLOR, width: 2, alpha: HIGHLIGHT_STROKE_ALPHA })
    }
    // 选中（更亮的描边）
    if (this.selected !== null && inBounds(this.selected, map.cols, map.rows)) {
      const { x, y } = cellToPixel(this.selected.col, this.selected.row)
      g.rect(x, y, CELL_SIZE, CELL_SIZE)
        .fill({ color: SELECTED_FILL, alpha: HIGHLIGHT_ALPHA })
        .stroke({ color: SELECTED_COLOR, width: 2.5, alpha: HIGHLIGHT_STROKE_ALPHA })
    }
  }

  /** 销毁本渲染器所有图层资源（由 Sandbox.tsx 在 app.destroy 前调用）。 */
  destroy(): void {
    this.root.destroy({ children: true })
  }
}

/** 选中 cell 填充色（白色，与 SELECTED_COLOR 配合）。 */
const SELECTED_FILL = 0xffffff

/** 判断坐标是否在网格范围内。 */
function inBounds(coord: { col: number; row: number }, cols: number, rows: number): boolean {
  return coord.col >= 0 && coord.row >= 0 && coord.col < cols && coord.row < rows
}

/** 把 v 夹到 [0,1]。 */
function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 在 Graphics 上画一条虚线（手动分段 lineTo，PIXI 8 Graphics 无内置 dashed）。
 */
function drawDashedLine(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dash: number,
  gap: number,
  color: number,
  width: number,
  alpha: number,
): void {
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.hypot(dx, dy)
  if (dist === 0) return
  const step = dash + gap
  const nx = dx / dist
  const ny = dy / dist
  let traveled = 0
  while (traveled < dist) {
    const segEnd = Math.min(traveled + dash, dist)
    g.moveTo(x1 + nx * traveled, y1 + ny * traveled)
      .lineTo(x1 + nx * segEnd, y1 + ny * segEnd)
      .stroke({ color, width, alpha })
    traveled += step
  }
}

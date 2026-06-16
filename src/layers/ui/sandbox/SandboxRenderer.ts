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
  isReconOrder,
} from './payload'
import {
  computeIntelRender,
  ghostAlpha,
  ghostLabel,
  type IntelRenderDecision,
  type IntelRenderMode,
  getPlayerFactionId,
} from './intel-visibility'
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
  RECON_LINE_ALPHA,
  RECON_LINE_COLOR,
  RECON_LINE_WIDTH,
  SELECTED_COLOR,
  STRENGTH_BAR_BG,
  STRENGTH_COLOR_HIGH,
  STRENGTH_COLOR_LOW,
  TERRAIN_COLORS,
  TERRAIN_FALLBACK_COLOR,
  UNIT_BORDER_COLOR,
  UNIT_BORDER_WIDTH,
  HEAT_PULSE_FILL_ALPHA,
  HEAT_PULSE_RING_ALPHA,
  INTEL_DASH_COLOR,
  INTEL_DASH_WIDTH,
  GHOST_LABEL_COLOR,
  factionColorToNumber,
} from './theme'
import { logger } from '@/utils/logger'
import { UNIT_TYPE_GLYPH } from '@/layers/ui/units/unit-glyph'

/** 沙盘交互回调集合（由 Sandbox.tsx 注入，渲染层不持有 store）。 */
export interface SandboxCallbacks {
  /** 点击某 cell（cellId 如 "C3"）。 */
  onCellClick?: (cellId: string) => void
  /**
   * 鼠标悬浮到某 cell（cellId 如 "C3"）；null=移出网格边界（清除悬浮）。
   * 第 3 批：用于 CellTooltip 显示该格坐标/地形/单位简报。
   * 由 handleStagePointer 的 move 模式触发（pointermove 高频，调用方应做去重）。
   */
  onCellHover?: (cellId: string | null) => void
}

/** updateWorld 入参：worldState 的渲染相关子集。 */
export interface SandboxWorld {
  map: GameMap
  units: Unit[]
  factions: Faction[]
  /**
   * 观察方阵营 id（通常为玩家阵营）。敌方单位按此方对其的 IntelLevel 渲染。
   * 缺省时回退取首个 side=player 阵营；仍无则全量渲染（无观察方）。
   */
  observerFactionId?: string
  /** 当前回合索引（计算残影用）。缺省取 0。 */
  currentTurn?: number
  /** 情报半衰回合数（残影判定用）。缺省取 3。 */
  halfLifeTurns?: number
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

  /** 单位残影标签 [T-Nh] Text 集合（单位层重绘时清理释放）。 */
  private ghostLabels: Text[] = []

  /**
   * 单位类型 glyph Text 集合（"步"/"装"/"炮" 等单字标识，画在军标中心）。
   * C 单位详情：所有可见单位（formation/full/own）都标 glyph，便于辨识。
   * 单位层重绘时一并清理释放。
   */
  private unitGlyphLabels: Text[] = []

  /** 当前世界快照（updateWorld 写入，redraw 读取）。 */
  private world: SandboxWorld | null = null
  /** 当前预演订单（updatePreview 写入）。 */
  private pendingOrders: ActionEnvelope[] = []

  private selected: { col: number; row: number } | null = null
  private hover: { col: number; row: number } | null = null

  /**
   * C 单位详情：当前选中单位 id（来自 store.selectedUnitId）。
   * redrawUnits 据此给该单位画青光描边 + 强化的类型 glyph。
   * null=无选中单位（不画描边，但仍画常规类型 glyph 标识）。
   */
  private selectedUnitId: string | null = null

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
    // —— 诊断日志：updateWorld 汇总（真机黑屏排查：是否真绘制了 cells/units）——
    // best-effort 写 diagnostics.log；cellsCount/unitsCount 为 0 说明 world 空或没喂数据。
    const cellsCount = world?.map.cells.length ?? 0
    const unitsCount = world?.units.length ?? 0
    const nodesCount = world?.map.highValueNodes.length ?? 0
    logger.debug('sandbox/render/update_world', 'SandboxRenderer.updateWorld 完成', {
      scope: 'app',
      hasWorld: world !== null,
      cellsCount,
      unitsCount,
      nodesCount,
      cols: world?.map.cols ?? 0,
      rows: world?.map.rows ?? 0,
    })
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

  /**
   * C 单位详情：设置选中单位 id（来自 store.selectedUnitId）。
   *
   * 触发单位层重绘——选中单位画青光描边 + 放大类型 glyph。
   * null 清除选中描边。
   */
  setSelectedUnitId(unitId: string | null): void {
    if (this.selectedUnitId === unitId) return
    this.selectedUnitId = unitId
    this.redrawUnits()
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
      // 第 3 批：通知上层当前悬浮 cellId（null=移出网格），驱动 CellTooltip。
      // cellId 用「列字母+1起步行号」格式（与 onCellClick 一致），便于上层按 cellId 反查 map.cells。
      const hoverCellId = cell === null ? null : `${colToLetter(cell.col)}${cell.row + 1}`
      this.callbacks.onCellHover?.(hoverCellId)
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

  /** 重绘预演虚线：move/capture 用青虚线（终点圆点），recon 用蓝虚线（终点十字）。 */
  private redrawPreview(): void {
    const g = this.previewGraphics
    g.clear()

    const units = this.world?.units
    if (units === undefined || this.pendingOrders.length === 0) return

    const unitById = new Map<string, Unit>()
    for (const u of units) unitById.set(u.id, u)

    for (const order of this.pendingOrders) {
      // payload 里找 unitId（宽容命名，由 payload.extractUnitId 处理）
      const unitId = extractUnitId(order.payload)
      if (unitId === null) continue
      const unit = unitById.get(unitId)
      if (unit === undefined) continue
      const target = extractTargetCoord(order.payload)
      if (target === null) continue

      const from = cellCenter(unit.coord.col, unit.coord.row)
      const to = cellCenter(target.col, target.row)

      // recon 命令：蓝虚线（短虚线段区分）+ 终点十字标记（表示侦察区域）
      if (isReconOrder(order)) {
        drawDashedLine(
          g,
          from.x,
          from.y,
          to.x,
          to.y,
          3,
          3,
          RECON_LINE_COLOR,
          RECON_LINE_WIDTH,
          RECON_LINE_ALPHA,
        )
        // 终点十字（侦察目标标记，区别移动的圆点）
        const arm = 5
        g.moveTo(to.x - arm, to.y).lineTo(to.x + arm, to.y).stroke({
          color: RECON_LINE_COLOR,
          width: RECON_LINE_WIDTH,
          alpha: RECON_LINE_ALPHA,
        })
        g.moveTo(to.x, to.y - arm).lineTo(to.x, to.y + arm).stroke({
          color: RECON_LINE_COLOR,
          width: RECON_LINE_WIDTH,
          alpha: RECON_LINE_ALPHA,
        })
        continue
      }

      // move/capture 命令：青虚线 + 终点圆点
      if (!isMoveLikeOrder(order)) continue
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

  /** 重绘单位军标 + 强度条（按观察方情报级别渲染敌方，己方恒 L3）。 */
  private redrawUnits(): void {
    const g = this.unitGraphics
    g.clear()
    // 清理上一轮残影标签 + 类型 glyph 标签（释放纹理）
    for (const t of this.ghostLabels) {
      this.unitLayer.removeChild(t)
      t.destroy()
    }
    this.ghostLabels = []
    for (const t of this.unitGlyphLabels) {
      this.unitLayer.removeChild(t)
      t.destroy()
    }
    this.unitGlyphLabels = []

    const world = this.world
    if (world === null) return
    const { units, factions } = world
    const factionById = new Map<string, Faction>()
    for (const f of factions) factionById.set(f.id, f)

    // 观察方确定：显式注入 > 首个 player 阵营；都无则全量渲染（无观察方）
    const observerFactionId =
      world.observerFactionId && world.observerFactionId.length > 0
        ? world.observerFactionId
        : getPlayerFactionId(factions)
    const currentTurn = world.currentTurn ?? 0
    const halfLifeTurns = world.halfLifeTurns ?? 3

    // —— 诊断计数：实际绘制单位数 + 按情报级别分布（真机黑屏排查：单位是否全被隐藏）——
    let drawnCount = 0
    let hiddenCount = 0
    const modeCounts: Record<string, number> = {}

    for (const unit of units) {
      // 无观察方时（测试/空场景）：按己方全量渲染（不隐藏任何单位）
      const decision: IntelRenderDecision =
        observerFactionId.length === 0
          ? {
              unitId: unit.id,
              mode: 'own' as IntelRenderMode,
              level: 3,
              ghost: false,
              ghostTurns: 0,
              staleTurns: 0,
              lastSeenTurn: currentTurn,
            }
          : computeIntelRender(unit, observerFactionId, currentTurn, halfLifeTurns)

      modeCounts[decision.mode] = (modeCounts[decision.mode] ?? 0) + 1

      // L0 盲区：完全不显示（玩家不知道该单位存在）
      if (decision.mode === 'hidden') {
        hiddenCount += 1
        continue
      }
      drawnCount += 1

      const alpha = ghostAlpha(decision)
      const faction = factionById.get(unit.factionId)
      const fill = factionColorToNumber(faction?.color)
      const { x, y } = cellCenter(unit.coord.col, unit.coord.row)
      const half = CELL_SIZE / 2 - 6

      // L1 热力脉冲：仅模糊色块（不画军标形状/类型/数值）
      if (decision.mode === 'heat-pulse') {
        // 半透明圆形热力块 + 脉冲外圈（两层同心圆暗示「热力」）
        g.circle(x, y, half)
          .fill({ color: fill, alpha: HEAT_PULSE_FILL_ALPHA * alpha })
        g.circle(x, y, half + 2)
          .stroke({ color: fill, width: 1.5, alpha: HEAT_PULSE_RING_ALPHA * alpha })
        // 热力脉冲不显示类型/强度条/残影标签（仅模糊存在性）
        continue
      }

      // L2 编制确认 / L3 全量透视 / 己方：画军标形状
      const isFormation = decision.mode === 'formation'
      if (unit.type === 'armor' || unit.type === 'artillery') {
        g.rect(x - half, y - half, half * 2, half * 2)
          .fill({ color: fill, alpha })
          .stroke({
            color: isFormation ? INTEL_DASH_COLOR : UNIT_BORDER_COLOR,
            width: isFormation ? INTEL_DASH_WIDTH : UNIT_BORDER_WIDTH,
            alpha,
          })
      } else {
        g.circle(x, y, half)
          .fill({ color: fill, alpha })
          .stroke({
            color: isFormation ? INTEL_DASH_COLOR : UNIT_BORDER_COLOR,
            width: isFormation ? INTEL_DASH_WIDTH : UNIT_BORDER_WIDTH,
            alpha,
          })
      }

      // L2 编制确认：用虚线描边覆盖（PIXI 8 stroke 无原生 dashed，补画虚线轮廓）
      if (isFormation) {
        drawDashedRect(g, x, y, half + 1, fill, alpha)
      }

      // 强度条：仅 L3/己方显示精确数值（L2 编制确认不显示血量）
      if (decision.mode === 'full' || decision.mode === 'own') {
        const ratio = clamp01(unit.strength / 100)
        const barW = half * 2
        const barH = 3
        const barX = x - half
        const barY = y + half + 2
        g.rect(barX, barY, barW, barH).fill({ color: STRENGTH_BAR_BG })
        const fgColor = ratio > 0.5 ? STRENGTH_COLOR_HIGH : STRENGTH_COLOR_LOW
        g.rect(barX, barY, barW * ratio, barH).fill({ color: fgColor, alpha })
      }

      // C 单位详情：类型 glyph 文字标识（formation/full/own 都画，便于辨识）。
      // L1 热力脉冲不画 glyph（仅模糊存在性，已 continue 跳过）。
      if (decision.mode === 'formation' || decision.mode === 'full' || decision.mode === 'own') {
        const glyph = UNIT_TYPE_GLYPH[unit.type]
        const glyphText = new Text({
          text: glyph,
          style: new TextStyle({
            fontFamily: 'monospace',
            fontSize: 10,
            fill: UNIT_GLYPH_COLOR,
            fontWeight: 'bold',
          }),
        })
        glyphText.anchor.set(0.5)
        glyphText.x = x
        glyphText.y = y
        glyphText.alpha = alpha
        this.unitLayer.addChild(glyphText)
        this.unitGlyphLabels.push(glyphText)
      }

      // C 单位详情：选中单位青光描边高亮（来自 store.selectedUnitId）。
      // 在军标外圈画一圈青光，比 cell 级 selected 描边更聚焦于单位本身。
      if (this.selectedUnitId !== null && unit.id === this.selectedUnitId) {
        const ringHalf = half + 3
        g.rect(x - ringHalf, y - ringHalf, ringHalf * 2, ringHalf * 2).stroke({
          color: SELECTED_COLOR,
          width: SELECTED_UNIT_RING_WIDTH,
          alpha: SELECTED_UNIT_RING_ALPHA,
        })
      }

      // 残影标签 [T-Nh]（仅 ghost 态）
      if (decision.ghost) {
        const label = ghostLabel(decision)
        if (label.length > 0) {
          const t = new Text({
            text: label,
            style: new TextStyle({
              fontFamily: 'monospace',
              fontSize: 9,
              fill: GHOST_LABEL_COLOR,
            }),
          })
          t.anchor.set(0.5, 0)
          t.x = x
          t.y = y - half - 12
          t.alpha = alpha
          this.unitLayer.addChild(t)
          this.ghostLabels.push(t)
        }
      }

      // 诱饵/欺骗单位：己方可见的虚线外框提示（仅 own/full 模式下提示）
      if (unit.deception === true && (decision.mode === 'own' || decision.mode === 'full')) {
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
          0.8 * alpha,
        )
      }

      void unitKey // 保留 key 函数引用（全量重画，预留增量优化）
    }

    // —— 诊断日志：单位绘制汇总（真机黑屏排查：drawnCount=0 说明全被情报规则隐藏）——
    logger.debug('sandbox/render/units', '单位层重绘完成', {
      scope: 'app',
      totalUnits: units.length,
      drawnCount,
      hiddenCount,
      observerFactionId,
      modeCounts,
    })
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

/** 类型 glyph 文字色（白色，叠在阵营色军标上对比清晰）。 */
const UNIT_GLYPH_COLOR = 0xffffff

/** 选中单位青光描边宽度（比 cell 级 selected 更粗，聚焦单位本身）。 */
const SELECTED_UNIT_RING_WIDTH = 2.5

/** 选中单位青光描边透明度（醒目但不遮挡军标）。 */
const SELECTED_UNIT_RING_ALPHA = 1

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

/**
 * 在 Graphics 上画一个虚线矩形边框（L2 编制确认军标用）。
 *
 * 四条边各用 drawDashedLine 画虚线，中心 (x,y)、半径 half。
 */
function drawDashedRect(
  g: Graphics,
  x: number,
  y: number,
  half: number,
  color: number,
  alpha: number,
): void {
  const left = x - half
  const right = x + half
  const top = y - half
  const bottom = y + half
  drawDashedLine(g, left, top, right, top, 4, 3, color, INTEL_DASH_WIDTH, alpha)
  drawDashedLine(g, right, top, right, bottom, 4, 3, color, INTEL_DASH_WIDTH, alpha)
  drawDashedLine(g, right, bottom, left, bottom, 4, 3, color, INTEL_DASH_WIDTH, alpha)
  drawDashedLine(g, left, bottom, left, top, 4, 3, color, INTEL_DASH_WIDTH, alpha)
}

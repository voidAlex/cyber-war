/**
 * 沙盘模块 barrel（layers/ui/sandbox）— PixiJS 8 战场沙盘渲染。
 *
 * 里程碑归属：M2（沙盘 + 握手 + 物理）。
 *
 * 导出：
 * - 默认导出 Sandbox（React 组件）
 * - SandboxRenderer（纯 PixiJS 渲染类，供测试/定制复用）
 * - 坐标纯函数（cellToPixel/colToLetter 等，可单测）
 * - 配色常量（theme）
 *
 * @module layers/ui/sandbox
 */

export { default } from './Sandbox'
export { SandboxRenderer } from './SandboxRenderer'
export type {
  SandboxCallbacks,
  SandboxWorld,
} from './SandboxRenderer'
export {
  CELL_SIZE,
  cellCenter,
  cellIdFromCoord,
  cellToPixel,
  colToLetter,
  coordFromCellId,
  gridPixelSize,
  letterToCol,
  pixelToCell,
} from './coords'
export {
  extractTargetCoord,
  extractUnitId,
  isMoveLikeOrder,
  readCoord,
  readString,
} from './payload'
export { TERRAIN_COLORS, factionColorToNumber } from './theme'
export {
  computeIntelRender,
  decideRenderMode,
  ghostLabel,
  ghostAlpha,
  visibleFieldsFor,
  listObservedEnemyUnits,
  toIntelSnapshot,
  getPlayerFactionId,
  shouldRefreshOnRecon,
} from './intel-visibility'
export type {
  IntelRenderMode,
  IntelRenderDecision,
} from './intel-visibility'

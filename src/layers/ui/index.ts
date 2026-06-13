/**
 * UI 层 barrel — React 视图（sandbox/terminal/dashboard/log-panel/inspector）。
 *
 * 里程碑归属：
 * - M1：SaveListPanel（存档列表）/ TurnControlPanel（回合控制）。
 * - sandbox（PixiJS 沙盘）：M2
 * - terminal（命令终端）/ dashboard（看板）：M2-M3
 * - log-panel（日志台）：M2
 * - inspector（Agent Inspector）：M3
 *
 * @module layers/ui
 */

export { default as SaveListPanel } from './SaveListPanel'
export { default as TurnControlPanel } from './TurnControlPanel'

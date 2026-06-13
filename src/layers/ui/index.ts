/**
 * UI 层 barrel — React 视图（sandbox/terminal/briefing/log-panel）。
 *
 * 里程碑归属：
 * - M1：SaveListPanel（存档列表）/ TurnControlPanel（回合控制）。
 * - sandbox（PixiJS 沙盘）：M2-B
 * - terminal（命令终端）：M2
 * - briefing（战报）：M2
 * - log-panel（日志台）：M2
 * - inspector（Agent Inspector）：M3
 *
 * @module layers/ui
 */

export { default as SaveListPanel } from './SaveListPanel'
export { default as TurnControlPanel } from './TurnControlPanel'
export { default as Sandbox } from './sandbox/Sandbox'
export { default as CommandTerminal } from './terminal/CommandTerminal'
export { default as BriefingPanel } from './briefing/BriefingPanel'
export { default as EventLogPanel } from './log-panel/EventLogPanel'

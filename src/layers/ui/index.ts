/**
 * UI 层 barrel — React 视图（sandbox/terminal/briefing/log-panel）。
 *
 * 里程碑归属：
 * - M1：SaveListPanel（存档列表）/ TurnControlPanel（回合控制）。
 * - sandbox（PixiJS 沙盘）：M2-B
 * - terminal（命令终端）：M2
 * - briefing（战报）：M2，M3 增强（流式 + 进度）
 * - log-panel（日志台）：M2
 * - config（LLM 配置面板）：M3
 * - ErrorBanner（错误四分类横幅）：M3
 * - inspector（Agent Inspector）：M3（dev）
 *
 * @module layers/ui
 */

export { default as SaveListPanel } from './SaveListPanel'
export { default as CampaignPanel } from './CampaignPanel'
export { default as TurnControlPanel } from './TurnControlPanel'
export { default as Sandbox } from './sandbox/Sandbox'
export { default as CommandTerminal } from './terminal/CommandTerminal'
export { default as BriefingPanel } from './briefing/BriefingPanel'
export { default as EventLogPanel } from './log-panel/EventLogPanel'
export { default as LLMConfigPanel } from './config/LLMConfigPanel'
export { default as ErrorBanner } from './ErrorBanner'
export { default as AgentInspector } from './inspector/AgentInspector'
export { default as IntelligencePanel } from './IntelligencePanel'
export { default as DiplomacyPanel } from './DiplomacyPanel'
export { default as ForcesPanel } from './ForcesPanel'
export { default as UnitDetailPanel } from './units/UnitDetailPanel'
export { default as CollapsibleSection } from './CollapsibleSection'
// A 标题屏主菜单（UI 重构第 2 批）：configUnlocked && context===null 时显示
export { default as TitleScreen } from './title/TitleScreen'

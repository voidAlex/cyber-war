/**
 * 应用主布局（App.tsx）— M3 UI 层接线。
 *
 * 布局（PRD §4 / TDD §2 + M3 范围#6）：
 * - 未解锁 LLM 配置 → 显示 LLMConfigPanel 作为入口（占满中心）。
 * - 已解锁 → 三栏主界面：
 *   - 左栏：SaveListPanel + TurnControlPanel
 *   - 中栏：Sandbox
 *   - 右栏：按 phase 切换 CommandTerminal / BriefingPanel
 * - 底部：EventLogPanel
 * - 全局：ErrorBanner（四分类错误横幅）
 * - 开发模式：AgentInspector（右栏底部或独立区）
 *
 * 挂载 zustand store；不直接调 @tauri-apps/api。
 *
 * @module App
 */

import { useEffect, type JSX } from 'react'
import { SaveListPanel, CampaignPanel, TurnControlPanel, Sandbox, CommandTerminal, BriefingPanel, EventLogPanel, LLMConfigPanel, ErrorBanner, AgentInspector, IntelligencePanel, DiplomacyPanel } from '@/layers/ui'
import SandboxErrorBoundary from '@/layers/ui/sandbox/SandboxErrorBoundary'
import { useGameStore } from '@/store/game-store'

/**
 * 应用根组件：根据 LLM 配置解锁态切换入口 / 主界面。
 */
export default function App(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const probeConfig = useGameStore((s) => s.probeConfig)
  const refreshSaves = useGameStore((s) => s.refreshSaves)

  const phase = context?.game.phase ?? 'idle'

  // 启动时探测配置是否存在 + 是否已解锁 + 刷新存档列表
  useEffect(() => {
    void probeConfig()
    void refreshSaves()
  }, [probeConfig, refreshSaves])

  // 未解锁：配置面板作为入口（仅显示全局错误横幅）
  if (!configUnlocked) {
    return (
      <div className="app-shell app-shell--locked">
        <GlobalBanner />
        <header className="app-shell__header">
          <h1>赛博战争模拟器</h1>
          <p className="app-shell__subtitle">Cyber War Simulator — 请先配置并解锁 LLM</p>
        </header>
        <main className="app-shell__main app-shell__main--centered">
          <LLMConfigPanel />
        </main>
      </div>
    )
  }

  // 右栏：briefing 阶段显示战报，其他阶段显示命令终端
  const showBriefing = phase === 'briefing'

  return (
    <div className="app-shell">
      <GlobalBanner />
      <header className="app-shell__header">
        <h1>赛博战争模拟器</h1>
        <p className="app-shell__subtitle">Cyber War Simulator — M3 Agent + 导演部 + 流式战报</p>
      </header>

      <main className="app-shell__main">
        <div className="app-shell__left">
          <SaveListPanel />
          <CampaignPanel />
          <TurnControlPanel />
          <IntelligencePanel />
          <DiplomacyPanel />
        </div>

        <div className="app-shell__center">
          {/* SandboxErrorBoundary：隔离沙盘崩溃，防止传播到整棵树（主界面其余面板不被卸载） */}
          <SandboxErrorBoundary>
            <Sandbox />
          </SandboxErrorBoundary>
        </div>

        <div className="app-shell__right">
          {showBriefing ? <BriefingPanel /> : <CommandTerminal />}
          <AgentInspector />
        </div>
      </main>

      <footer className="app-shell__footer">
        <EventLogPanel />
      </footer>
    </div>
  )
}

/** 全局错误横幅包装（定位在顶部） */
function GlobalBanner(): JSX.Element {
  return (
    <div className="app-shell__banner">
      <ErrorBanner />
    </div>
  )
}

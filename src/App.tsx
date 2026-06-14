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
 * UI 重设计（赛博朋克全息青蓝）：header 升级为 HUD 横条——
 * Orbitron 标题 + 青光描边 + 装饰角括号 + 状态指示灯（连接/解锁/回合）+ 版本号。
 *
 * @module App
 */

import { useEffect, type JSX } from 'react'
import { SaveListPanel, CampaignPanel, TurnControlPanel, Sandbox, CommandTerminal, BriefingPanel, EventLogPanel, LLMConfigPanel, ErrorBanner, AgentInspector, IntelligencePanel, DiplomacyPanel } from '@/layers/ui'
import SandboxErrorBoundary from '@/layers/ui/sandbox/SandboxErrorBoundary'
import { useGameStore } from '@/store/game-store'

/** 应用版本号（HUD 右下显示）。 */
const APP_VERSION = 'v0.4.0'

/**
 * 应用根组件：根据 LLM 配置解锁态切换入口 / 主界面。
 */
export default function App(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const config = useGameStore((s) => s.config)
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
        <AppHeader
          phase={phase}
          turnIndex={context?.game.world.turnIndex ?? null}
          configUnlocked={false}
          hasConfig={config !== null}
        />
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
      <AppHeader
        phase={phase}
        turnIndex={context?.game.world.turnIndex ?? null}
        configUnlocked={true}
        hasConfig={config !== null}
      />

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

/**
 * 应用 Header（赛博朋克 HUD 横条）。
 *
 * 包含：Orbitron 标题（青光描边）、副标题、状态指示灯条（连接/解锁/回合）、版本号。
 * 角装饰（L 形角括号）由 CSS .app-shell__header::before/::after 实现。
 */
function AppHeader(props: {
  phase: string
  turnIndex: number | null
  configUnlocked: boolean
  hasConfig: boolean
}): JSX.Element {
  const { phase, turnIndex, configUnlocked, hasConfig } = props
  const isLockedScreen = !configUnlocked

  return (
    <header className="app-shell__header">
      <div className="app-shell__header-row">
        <div className="app-shell__title-block">
          <h1>赛博战争模拟器</h1>
          <p className="app-shell__subtitle">
            {isLockedScreen
              ? 'Cyber War Simulator — 请先配置 LLM'
              : 'Cyber War Simulator — Agent + 导演部 + 流式战报'}
          </p>
        </div>

        {/* 状态指示灯条（HUD 右侧） */}
        <div className="app-shell__status-bar">
          <span className="app-shell__status-item">
            <span
              className={
                'app-shell__status-dot' +
                (hasConfig ? ' app-shell__status-dot--on' : ' app-shell__status-dot--off')
              }
            />
            LLM {hasConfig ? 'ONLINE' : 'OFFLINE'}
          </span>

          <span className="app-shell__status-item">
            <span
              className={
                'app-shell__status-dot' +
                (configUnlocked
                  ? ' app-shell__status-dot--on'
                  : ' app-shell__status-dot--warn')
              }
            />
            {configUnlocked ? 'UNLOCKED' : 'LOCKED'}
          </span>

          {!isLockedScreen && (
            <span className="app-shell__status-item">
              <span className="app-shell__status-dot app-shell__status-dot--on" />
              TURN {turnIndex ?? 0} · {phase.toUpperCase()}
            </span>
          )}

          <span className="app-shell__version">{APP_VERSION}</span>
        </div>
      </div>
    </header>
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

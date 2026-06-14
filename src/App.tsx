/**
 * 应用主布局（App.tsx）— M3 UI 层接线。
 *
 * 布局（PRD §4 / TDD §2 + M3 范围#6）：
 * - 未加载 LLM 配置 → 显示 LLMConfigPanel 作为入口（占满中心）。
 * - 已加载 → 三栏主界面：
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
import { logger } from '@/utils/logger'

/** 应用版本号（HUD 右下显示）。 */
const APP_VERSION = 'v0.4.0'

/**
 * 应用根组件：根据 LLM 配置解锁态切换入口 / 主界面。
 */
export default function App(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const config = useGameStore((s) => s.config)
  const loadConfig = useGameStore((s) => s.loadConfig)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  // legacy/no-api-key 场景：旧 config 文件的非密钥字段（异步 loadConfig 完成后才写入 store）。
  // 用于给 LLMConfigPanel 容器打 key，在 pendingConfig 到达后强制重挂载，使 useState 重取
  // 初值（预填 provider/endpoint/model 生效），避免用户看到默认 DeepSeek 而非旧 config。
  const pendingConfig = useGameStore((s) => s.pendingConfig)

  const phase = context?.game.phase ?? 'idle'

  // 启动时加载配置（读 config 文件 + keyring，无口令）+ 刷新存档列表
  useEffect(() => {
    // 应用启动事件（写 app.log，便于排查启动/配置问题）
    logger.info('app/startup', '应用启动', { scope: 'app', version: APP_VERSION })
    void loadConfig()
    void refreshSaves()
  }, [loadConfig, refreshSaves])

  // 全局未捕获错误：写 app.log（best-effort，便于排查致命崩溃）
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      logger.error('app/window/onerror', `未捕获错误: ${event.message}`, {
        scope: 'app',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      })
    }
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason = event.reason
      logger.error(
        'app/window/unhandledrejection',
        `未处理的 Promise 拒绝: ${reason instanceof Error ? reason.message : String(reason)}`,
        { scope: 'app' },
      )
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  // 未加载配置：配置面板作为入口（仅显示全局错误横幅）
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
          {/* key 随 pendingConfig 变化强制重挂载：legacy 场景 pendingConfig 异步到达后
              useState 初值才会取到旧 config 的 provider/endpoint/model（预填生效）。
              apiKey 在 pendingConfig 视图本就为空，重挂载不丢失用户已输入内容。 */}
          <LLMConfigPanel key={pendingConfig ? 'legacy' : 'fresh'} />
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
            {/* 去口令语义残留：与左侧「LLM ONLINE/OFFLINE」对齐，
                配置了 apiKey=READY，未配置=NEEDS API KEY。 */}
            {configUnlocked ? 'LLM READY' : 'NEEDS API KEY'}
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

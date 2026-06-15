/**
 * 应用主布局（App.tsx）— M3 UI 层接线 + A 标题屏三态路由。
 *
 * 三态路由（UI 重构第 2 批「A 标题屏」）：
 * - **configLock**（`!configUnlocked`）：LLMConfigPanel 铺满（首次配置 / legacy 重输 apiKey）。
 * - **titleScreen**（`configUnlocked && context === null`）：TitleScreen 标题屏主菜单
 *   （logo + 新战役 / 继续存档 / 设置 + 底部状态条）。玩家启动后先看标题屏选战役/存档，
 *   不再直通半空三栏。
 * - **inGame**（`context !== null`）：三栏游戏界面（D 布局，无 footer，沙盘吃满中栏）：
 *   - 左栏（按功能分组，3 组 CollapsibleSection）：
 *     · 行动组：回合控制（TurnControlPanel）
 *     · 信息组：情报（IntelligencePanel）+ 外交（DiplomacyPanel）
 *     · 系统组：存档（SaveListPanel）+ 战役包（CampaignPanel）
 *   - 中栏：Sandbox（flex 1 吃满，移除 footer 后不再"太长"）
 *   - 右栏（对话/命令/战报 + 日志同栏，不跳视线）：
 *     · 上：按 phase 切换 CommandTerminal / BriefingPanel
 *     · 中：AgentInspector（DEV 折叠）
 *     · 底：EventLogPanel（从视口底部 footer 移此，~150px 紧凑）
 * - 全局：ErrorBanner（四分类错误横幅）
 *
 * 挂载 zustand store；不直接调 @tauri-apps/api。
 *
 * UI 重设计（赛博朋克全息青蓝）：header 升级为 HUD 横条——
 * Orbitron 标题 + 青光描边 + 装饰角括号 + 状态指示灯（连接/解锁/回合）+ 版本号。
 *
 * @module App
 */

import { useEffect, type JSX } from 'react'
import { SaveListPanel, CampaignPanel, TurnControlPanel, Sandbox, CommandTerminal, BriefingPanel, EventLogPanel, LLMConfigPanel, ErrorBanner, AgentInspector, IntelligencePanel, DiplomacyPanel, ForcesPanel, UnitDetailPanel, CollapsibleSection, DecisionPanel } from '@/layers/ui'
import TitleScreen from '@/layers/ui/title/TitleScreen'
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
  // 存档列表（左栏折叠态摘要用）
  const saves = useGameStore((s) => s.saves)
  // legacy/no-api-key 场景：旧 config 文件的非密钥字段（异步 loadConfig 完成后才写入 store）。
  // 用于给 LLMConfigPanel 容器打 key，在 pendingConfig 到达后强制重挂载，使 useState 重取
  // 初值（预填 provider/endpoint/model 生效），避免用户看到默认 DeepSeek 而非旧 config。
  const pendingConfig = useGameStore((s) => s.pendingConfig)

  const phase = context?.game.phase ?? 'idle'
  // 当前回合号（左栏折叠态摘要 + header 状态灯共用）
  const turnIndex = context?.game.world.turnIndex ?? null

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
      // ResizeObserver loop 是良性警告（resize 回调触发新 layout），不写 app.log
      // （否则真机每帧刷爆日志）。仅记录真错误。
      if (event.message?.includes('ResizeObserver loop')) return
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

  // ===========================================================================
  // 三态路由（A 标题屏）：configLock → titleScreen → inGame
  // ===========================================================================

  // ① configLock：未加载 LLM 配置（首次 / legacy 重输 apiKey）→ LLMConfigPanel 铺满
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

  // ② titleScreen：已解锁配置但未进入游戏（context === null）→ 标题屏主菜单
  //    玩家启动后先看标题屏选战役/存档，不再直通半空三栏。
  if (context === null) {
    return (
      <div className="app-shell app-shell--title">
        <GlobalBanner />
        <TitleScreen />
      </div>
    )
  }

  // ③ inGame：已进入游戏（context !== null）→ 三栏游戏界面（D 布局）
  // 右栏：briefing 阶段显示战报；decision 阶段显示战术决策面板；其他阶段显示命令终端
  const showBriefing = phase === 'briefing'
  const showDecision = phase === 'decision'

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
          {/* 左栏按功能分 3 组（D 布局重构：5 折叠条 → 3 组，减少拥挤）。
              每组一个 CollapsibleSection header，组内可含多个面板。
              默认展开策略：行动/系统常用（开），信息查看型（收起）。 */}

          {/* 行动组：回合控制（每回合必用，默认展开） */}
          <CollapsibleSection
            title="行动"
            defaultOpen={true}
            collapsedHint={turnIndex !== null ? `第 ${turnIndex} 回合` : undefined}
          >
            <div className="collapsible-group__panels">
              <TurnControlPanel />
            </div>
          </CollapsibleSection>

          {/* 信息组：部队 + 情报 + 外交（查看型，默认收起）。
              部队 ForcesPanel 放最前（玩家最常用：点单位看详情 + 沙盘高亮）。 */}
          <CollapsibleSection title="信息" defaultOpen={false}>
            <div className="collapsible-group__panels">
              <ForcesPanel />
              <IntelligencePanel />
              <DiplomacyPanel />
            </div>
          </CollapsibleSection>

          {/* 系统组：存档 + 战役包（存档常用，默认展开） */}
          <CollapsibleSection
            title="系统"
            defaultOpen={true}
            collapsedHint={`${saves.length} 个存档`}
          >
            <div className="collapsible-group__panels">
              <SaveListPanel />
              <CampaignPanel />
            </div>
          </CollapsibleSection>
        </div>

        <div className="app-shell__center">
          {/* SandboxErrorBoundary：隔离沙盘崩溃，防止传播到整棵树（主界面其余面板不被卸载） */}
          <SandboxErrorBoundary>
            <Sandbox />
          </SandboxErrorBoundary>
          {/* C 单位详情：选中单位浮层（覆盖沙盘右上，selectedUnitId 非空时显示）。
              UnitDetailPanel 内部据 selectedUnitId 判断渲染 null / 浮层，无需此处条件。 */}
          <UnitDetailPanel />
        </div>

        <div className="app-shell__right">
          {/* 右栏（D 布局重构）：对话/命令/战报 + AgentInspector + 日志同栏，
              日志从视口底部 footer 移此底部，不再割裂视线。
              上区 flex 1（终端/战报吃满），日志固定底部 ~150px。 */}
          <div className="app-shell__right-main">
            {showDecision ? (
              <DecisionPanel />
            ) : showBriefing ? (
              <BriefingPanel />
            ) : (
              <CommandTerminal />
            )}
            <AgentInspector />
          </div>
          <div className="app-shell__right-log">
            <EventLogPanel />
          </div>
        </div>
      </main>
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

/**
 * 应用主布局（App.tsx）— UI 重构第 1 批「全对话为主」。
 *
 * 三态路由（UI 重构第 2 批「A 标题屏」）：
 * - **configLock**（`!configUnlocked`）：LLMConfigPanel 铺满。
 * - **titleScreen**（`configUnlocked && context === null`）：TitleScreen 标题屏主菜单。
 * - **inGame**（`context !== null`）：三栏游戏界面（全对话为主布局）：
 *
 * 全对话为主布局（第 1 批）：
 *   ┌────────┬────────────────┬────────┐
 *   │Header 时间 第3天 D+3              │
 *   ├────────┼────────────────┼────────┤
 *   │行动    │ 对话气泡流     │小沙盘  │
 *   │系统    │ （参谋/外交/   │(弹窗)  │
 *   │保存    │  指挥官分色)   │信息栏  │
 *   │退出    │ 输入框         │(情报/  │
 *   │        │                │ 外交/  │
 *   │        │                │ 部队)  │
 *   │        │                │导演部  │
 *   └────────┴────────────────┴────────┘
 *   - 左栏（简化）：行动组（回合控制）+ 系统组（保存 + 退出）。
 *   - 中栏：DialogueStream 对话气泡流 + 输入框（主体）；battle 阶段叠加战果弹窗。
 *   - 右栏：MiniSandbox（点击弹 SandboxOverlay 全屏）+ InfoTabs（情报/外交/部队）+ 导演部。
 *
 * Header 时间显示：`{inGameDate}（第{n}天 D+{n}）`（从 manifest.startInGameDate + turnIndex 推算）。
 *
 * 挂载 zustand store；不直接调 @tauri-apps/api。
 *
 * @module App
 */

import { useEffect, useState, type JSX } from 'react'
import {
  TurnControlPanel,
  CommandTerminal,
  BriefingPanel,
  EventLogPanel,
  LLMConfigPanel,
  ErrorBanner,
  AgentInspector,
  CollapsibleSection,
  DecisionPanel,
} from '@/layers/ui'
import TitleScreen from '@/layers/ui/title/TitleScreen'
import CampaignCreatorPage from '@/layers/ui/campaign-creator/CampaignCreatorPage'
import DialogueStream from '@/layers/ui/terminal/DialogueStream'
import MiniSandbox from '@/layers/ui/sandbox/MiniSandbox'
import SandboxOverlay from '@/layers/ui/sandbox/SandboxOverlay'
import InfoTabs from '@/layers/ui/InfoTabs'
import BattleResultModal from '@/layers/ui/briefing/BattleResultModal'
import OpeningBriefing from '@/layers/ui/briefing/OpeningBriefing'
import GameOverModal from '@/layers/ui/briefing/GameOverModal'
import { useGameStore } from '@/store/game-store'
import { logger } from '@/utils/logger'
import { formatHeaderDate, DEFAULT_DAYS_PER_TURN } from '@/utils/in-game-date'
// 第 5 批：Header 时间推算所需 manifest 直接从内置战役注册表查（凡尔登/官渡/俄乌/
// 中途岛/美以伊 全部覆盖）；导入 ZIP 包时按其 scenarioId 增量补充。
import { BUILTIN_MANIFESTS_BY_ID } from '@/data/registry'

/** 应用版本号（HUD 右下显示）。 */
const APP_VERSION = 'v0.4.0'

/** 当前内置战役清单（用于 Header 时间推算 startInGameDate/daysPerTurn）。
 *  按 scenarioId 查；从 src/data/registry 复用，未来 ZIP 导入包时增量补充。 */
const MANIFESTS_BY_SCENARIO = BUILTIN_MANIFESTS_BY_ID

/**
 * 应用根组件：根据 LLM 配置解锁态切换入口 / 主界面。
 */
export default function App(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const config = useGameStore((s) => s.config)
  const loadConfig = useGameStore((s) => s.loadConfig)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const pendingConfig = useGameStore((s) => s.pendingConfig)
  // 第 5 批：创建战役独立页路由态（第四态 creatorPage）
  const creatorPageActive = useGameStore((s) => s.creatorPageActive)
  const setCreatorPageActive = useGameStore((s) => s.setCreatorPageActive)

  const phase = context?.game.phase ?? 'idle'
  const turnIndex = context?.game.world.turnIndex ?? null

  // 启动时加载配置 + 刷新存档列表
  useEffect(() => {
    logger.info('app/startup', '应用启动', { scope: 'app', version: APP_VERSION })
    void loadConfig()
    void refreshSaves()
  }, [loadConfig, refreshSaves])

  // 全局未捕获错误：写 app.log
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
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
  // 三态路由：configLock → titleScreen → inGame
  // ===========================================================================

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
          <LLMConfigPanel key={pendingConfig ? 'legacy' : 'fresh'} />
        </main>
      </div>
    )
  }

  if (context === null) {
    // 第 5 批：creatorPage 第四态（标题屏 → LLM 生成战役 → 独立创建页）。
    // creatorPageActive=true 时渲染 CampaignCreatorPage，退出/确认开局回 false。
    if (creatorPageActive) {
      return (
        <div className="app-shell app-shell--creator">
          <GlobalBanner />
          <CampaignCreatorPage
            onExit={() => setCreatorPageActive(false)}
          />
        </div>
      )
    }
    return (
      <div className="app-shell app-shell--title">
        <GlobalBanner />
        <TitleScreen />
      </div>
    )
  }

  // 进入游戏后（context !== null）创建页 flag 不影响渲染；退出游戏回标题屏时
  // creatorPageActive 仍可能为 true，由 TitleScreen 重新进入创建页或用户点返回处理。
  // GameScreen 内退出 handleExit 已重置 context=null 但不清 creatorPageActive，
  // 故此处置 false 避免退出后仍停在创建页。
  return <GameScreen context={context} phase={phase} turnIndex={turnIndex} />
}

/**
 * 游戏主界面（inGame 三栏，全对话为主布局）。
 *
 * 拆为子组件以隔离弹窗（SandboxOverlay/BattleResultModal）的局部 state。
 */
function GameScreen({
  context,
  phase,
  turnIndex,
}: {
  context: NonNullable<ReturnType<typeof useGameStore.getState>['context']>
  phase: string
  turnIndex: number | null
}): JSX.Element {
  // 全屏沙盘弹窗（MiniSandbox 点击触发）
  const [sandboxOpen, setSandboxOpen] = useState(false)
  // 退出确认对话框
  const [confirmExit, setConfirmExit] = useState(false)
  // 战果弹窗是否已 dismiss（briefing 阶段弹一次，玩家关闭后不再自动弹）
  const [battleResultDismissed, setBattleResultDismissed] = useState(false)

  const showBriefing = phase === 'briefing'
  const showDecision = phase === 'decision'

  // 第 4 批：自动保存角标（advance/resolveDecision 落盘成功后 3s 内 true）
  const showSavedIndicator = useGameStore((s) => s.showSavedIndicator)
  const lastSavedAt = useGameStore((s) => s.lastSavedAt)
  // 第 5 批：开场参谋长简报弹窗（新战役开局后 store 标记 true，玩家关闭后 false）
  const showOpeningBriefing = useGameStore((s) => s.showOpeningBriefing)
  const dismissOpeningBriefing = useGameStore((s) => s.dismissOpeningBriefing)
  // 第 6 批：胜负终局弹窗（advanceTurn 结算后若 victoryState !== 'ongoing' 则 true）。
  // 最高优先级，覆盖 BattleResultModal / OpeningBriefing。
  const showGameOver = useGameStore((s) => s.showGameOver)

  // 推算 Header 时间显示（manifest.startInGameDate + turnIndex × daysPerTurn）
  const scenarioId = context.game.world.scenarioId
  const manifest = MANIFESTS_BY_SCENARIO[scenarioId]
  const startInGameDate = manifest?.startInGameDate
  const daysPerTurn = manifest?.daysPerTurn ?? DEFAULT_DAYS_PER_TURN
  const headerDate =
    turnIndex !== null
      ? formatHeaderDate(startInGameDate, turnIndex, daysPerTurn)
      : null

  // phase 离开 briefing 时重置 dismissed（下次进入 briefing 重新弹窗）
  useEffect(() => {
    if (phase !== 'briefing') {
      setBattleResultDismissed(false)
    }
  }, [phase])

  /** 退出游戏：清上下文回标题屏（context=null） */
  const handleExit = (): void => {
    logger.info('ui/exit', '玩家退出游戏回标题屏', {
      scope: 'save',
      saveId: context.game.world.saveId,
      turn: context.game.world.turnIndex,
    })
    // Bug3 修复：退出时清空对话记忆（store reset），下次进游戏从空白开始
    // 第 5 批：同时关闭创建页 flag，确保退出回标题屏（非创建页）
    // 第 6 批：同时关闭胜负终局弹窗 flag（避免下一局开局残留）
    useGameStore.setState({
      context: null,
      saveId: null,
      selectedUnitId: null,
      creatorPageActive: false,
      showGameOver: false,
    })
    useGameStore.getState().clearDialogues()
    setConfirmExit(false)
  }

  return (
    <div className="app-shell">
      <GlobalBanner />
      <AppHeader
        phase={phase}
        turnIndex={turnIndex}
        configUnlocked={true}
        hasConfig={useGameStore.getState().config !== null}
        headerDate={headerDate}
        showSavedIndicator={showSavedIndicator}
        lastSavedAt={lastSavedAt}
      />

      <main className="app-shell__main app-shell__main--dialogue">
        {/* —— 左栏：行动 + 系统（简化）—— */}
        <div className="app-shell__left">
          <CollapsibleSection
            title="行动"
            defaultOpen={true}
            collapsedHint={turnIndex !== null ? `第 ${turnIndex + 1} 天` : undefined}
          >
            <div className="collapsible-group__panels">
              <TurnControlPanel />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="系统" defaultOpen={true}>
            <div className="collapsible-group__panels">
              <SystemPanel onSave={null} onExit={() => setConfirmExit(true)} />
            </div>
          </CollapsibleSection>
        </div>

        {/* —— 中栏：对话气泡流（主体）+ 命令叠加 —— */}
        <div className="app-shell__center app-shell__center--dialogue">
          <DialogueStream />

          {/* decision/briefing 时中栏叠加决策/战报面板（命令终端移至右栏） */}
          {showDecision && (
            <div className="app-shell__center-overlay">
              <DecisionPanel />
            </div>
          )}
        </div>

        {/* —— 右栏：小沙盘 + 信息栏 + 导演部 —— */}
        <div className="app-shell__right app-shell__right--dialogue">
          <MiniSandbox onOpen={() => setSandboxOpen(true)} />
          <InfoTabs defaultTab="forces" />
          {/* 命令候选/外交/锁定（右栏中部，与对话流共享 useCommandDialogue） */}
          {showBriefing ? (
            <BriefingPanel />
          ) : showDecision ? null : (
            <CommandTerminal />
          )}
          <AgentInspector />
          <div className="app-shell__right-log">
            <EventLogPanel />
          </div>
        </div>
      </main>

      {/* 全屏沙盘弹窗 */}
      <SandboxOverlay open={sandboxOpen} onClose={() => setSandboxOpen(false)} />

      {/* 第 6 批：胜负终局弹窗优先级最高——已终局时覆盖其他弹窗。
          三弹窗不冲突的实现：showGameOver===true 时不渲染 BattleResultModal /
          OpeningBriefing（GameScreen 内条件短路）。GameOverModal 内部自带 Esc 关闭。 */}
      {showGameOver ? (
        <GameOverModal />
      ) : (
        <>
          {/* 战果弹窗（briefing 阶段，未 dismiss 时弹一次） */}
          <BattleResultModal
            open={showBriefing && !battleResultDismissed}
            onClose={() => setBattleResultDismissed(true)}
          />

          {/* 第 5 批：开场参谋长简报弹窗（新战役开局叠加，玩家关闭后进入正常游戏） */}
          {showOpeningBriefing && <OpeningBriefing onDismiss={dismissOpeningBriefing} />}
        </>
      )}

      {/* 退出确认对话框 */}
      {confirmExit && (
        <ConfirmDialog
          message="确定退出？进度已自动保存。"
          confirmLabel="退出"
          cancelLabel="取消"
          onConfirm={handleExit}
          onCancel={() => setConfirmExit(false)}
        />
      )}
    </div>
  )
}

/**
 * 系统组面板（保存 + 退出）。
 *
 * 第 1 批简化：原 CampaignPanel/SaveListPanel/CampaignGeneratorPanel 移至标题屏处理，
 * 游戏内仅保留「手动保存」（委托 store 持久化编排）+「退出」。
 *
 * @param onSave 保存回调（null 时隐藏保存按钮——当前回合自动落盘，仅留退出）
 * @param onExit 退出回调
 */
function SystemPanel({ onSave, onExit }: { onSave: (() => void) | null; onExit: () => void }): JSX.Element {
  return (
    <section className="panel system-panel">
      <h2 className="panel__title">系统</h2>
      <div className="system-panel__actions">
        {onSave !== null && (
          <button type="button" onClick={onSave}>保存进度</button>
        )}
        <button type="button" className="system-panel__exit" onClick={onExit}>退出到标题屏</button>
      </div>
    </section>
  )
}

/**
 * 确认对话框（通用，赛博朋克青光 modal）。
 */
function ConfirmDialog({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div className="confirm-dialog" role="alertdialog" aria-modal="true">
      <div className="confirm-dialog__card">
        <p className="confirm-dialog__message">{message}</p>
        <div className="confirm-dialog__actions">
          <button type="button" className="confirm-dialog__cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="confirm-dialog__confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 应用 Header（赛博朋克 HUD 横条）。
 *
 * 时间显示：`{inGameDate}（第{n}天 D+{n}）`（headerDate）；无日期时回退 `TURN {n}`。
 */
function AppHeader(props: {
  phase: string
  turnIndex: number | null
  configUnlocked: boolean
  hasConfig: boolean
  headerDate?: string | null
  showSavedIndicator?: boolean
  lastSavedAt?: number | null
}): JSX.Element {
  const { phase, turnIndex, configUnlocked, hasConfig, headerDate, showSavedIndicator, lastSavedAt } = props
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
            {configUnlocked ? 'LLM READY' : 'NEEDS API KEY'}
          </span>

          {!isLockedScreen && (
            <span className="app-shell__status-item app-shell__status-item--time">
              <span className="app-shell__status-dot app-shell__status-dot--on" />
              {headerDate ?? `TURN ${turnIndex ?? 0}`}
              <span className="app-shell__status-phase">· {phase.toUpperCase()}</span>
            </span>
          )}

          {/* 第 4 批：自动保存角标（advance 落盘成功后 3s 内闪现"✓ 已保存"） */}
          {!isLockedScreen && showSavedIndicator && (
            <span
              className="app-shell__status-item app-shell__saved-indicator"
              role="status"
              aria-label={
                lastSavedAt != null
                  ? `第 ${lastSavedAt + 1} 天已保存`
                  : '已保存'
              }
            >
              <span className="app-shell__status-dot app-shell__status-dot--on" />
              ✓ 已保存
              {lastSavedAt != null && (
                <span className="app-shell__saved-turn">第 {lastSavedAt + 1} 天</span>
              )}
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

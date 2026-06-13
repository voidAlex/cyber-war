/**
 * 应用主布局（App.tsx）— M2 可玩闭环接线。
 *
 * 布局（PRD §4 / TDD §2）：
 * - 左栏：SaveListPanel（存档）+ TurnControlPanel（回合状态）。
 * - 中栏：Sandbox（沙盘，读 pendingOrders 画虚线预演）。
 * - 右栏：按 phase 切换 CommandTerminal（planning/handshake/locked/idle）
 *         与 BriefingPanel（briefing）。
 * - 底部：EventLogPanel（事件日志台，虚拟滚动）。
 *
 * 挂载 zustand store（已在 game-store.ts 单例）；不直接调 @tauri-apps/api。
 *
 * @module App
 */

import { type JSX } from 'react'
import { SaveListPanel, TurnControlPanel, Sandbox, CommandTerminal, BriefingPanel, EventLogPanel } from '@/layers/ui'
import { useGameStore } from '@/store/game-store'

/**
 * 应用根组件：三栏 + 底部最小可用布局（不要求美观）。
 */
export default function App(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const phase = context?.game.phase ?? 'idle'

  // 右栏：briefing 阶段显示战报，其他阶段显示命令终端
  const showBriefing = phase === 'briefing'

  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h1>赛博战争模拟器</h1>
        <p className="app-shell__subtitle">Cyber War Simulator — M2 握手 + 物理 + 沙盘闭环</p>
      </header>

      <main className="app-shell__main">
        <div className="app-shell__left">
          <SaveListPanel />
          <TurnControlPanel />
        </div>

        <div className="app-shell__center">
          <Sandbox />
        </div>

        <div className="app-shell__right">
          {showBriefing ? <BriefingPanel /> : <CommandTerminal />}
        </div>
      </main>

      <footer className="app-shell__footer">
        <EventLogPanel />
      </footer>
    </div>
  )
}

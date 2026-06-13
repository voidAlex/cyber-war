/**
 * 应用最小布局壳（M1 可演示闭环）。
 *
 * M1 阶段挂载存档列表 + 回合控制两个面板，演示「创建存档 → 空转推进回合 →
 * 刷新/重启后状态完整恢复」闭环。沙盘/终端等由后续里程碑接入。
 *
 * 通过 zustand store 订阅；不直接调 @tauri-apps/api。
 *
 * @module App
 */

import { type JSX } from 'react'
import SaveListPanel from '@/layers/ui/SaveListPanel'
import TurnControlPanel from '@/layers/ui/TurnControlPanel'

/**
 * 应用根组件。
 * M1：左侧存档列表 + 右侧回合控制，最小布局（不要求美观，M2 再做沙盘）。
 */
export default function App(): JSX.Element {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h1>赛博战争模拟器</h1>
        <p className="app-shell__subtitle">Cyber War Simulator — M1 骨架闭环</p>
      </header>
      <main className="app-shell__main">
        <SaveListPanel />
        <TurnControlPanel />
      </main>
    </div>
  )
}

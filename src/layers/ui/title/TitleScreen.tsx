/**
 * 标题屏（TitleScreen.tsx）— A 标题屏主菜单（UI 重构第 2 批）。
 *
 * 职责（对应重写计划「A 标题屏主菜单」）：
 * - 赛博朋克全屏背景（扫描线 + 网格 + 径向光晕，复用 body 背景 + 独立 .title-screen 叠加）。
 * - 中央大 logo（Orbitron "CYBER WAR SIMULATOR" + 中文「赛博战争模拟器」，
 *   青光描边 + 辉光）。
 * - 三主菜单按钮（chamfered 切角 + 青光描边 + hover 扫光）：
 *   · ▶ 新战役：展开 CampaignPanel（凡尔登默认包 / 导入 ZIP / LLM 生成）。
 *   · ▶ 继续存档：展开 SaveListPanel（存档列表 + 载入）。
 *   · ⚙ 设置：展开 LLMConfigPanel（provider/endpoint/model/apiKey）。
 * - 底部状态条：版本号 + LLM 状态（DeepSeek v4-flash / 未配置）。
 *
 * 设计说明：
 * - 组件 JSX 逻辑复用：CampaignPanel / SaveListPanel / LLMConfigPanel 不重写，
 *   仅作为容器内联渲染（点击主菜单按钮切换 activePanel 展开区）。
 * - 离线也能进游戏：store mock 角色已支持未配 LLM 走 mock 推演；
 *   未配 LLM 也能进标题屏看战役/存档（推演走 mock）。
 * - gateway 唯一 import @tauri-apps/api；本组件经 store/hooks，不直接调 gateway。
 *
 * 三态路由（App.tsx）中的 titleScreen 态：
 *   configUnlocked === true && context === null → 显示本组件。
 * 进入游戏（context !== null）后由 App 切换到三栏游戏界面，本组件卸载。
 *
 * @module layers/ui/title/TitleScreen
 */

import { useState, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { CampaignPanel, SaveListPanel, LLMConfigPanel } from '@/layers/ui'
import { Play, FolderOpen, Settings, Sparkles } from '@/layers/ui/icons'

/** 当前展开的面板（null = 仅显示主菜单，无展开区） */
type ActivePanel = 'campaign' | 'saves' | 'settings' | null

/** 应用版本号（底部状态条显示，与 App.tsx APP_VERSION 保持一致） */
const APP_VERSION = 'v0.4.0'

/**
 * 标题屏主菜单组件。
 *
 * 渲染：全屏背景 + 中央 logo + 三主菜单 + 展开区（按 activePanel 切换）+ 底部状态条。
 * 主菜单点击切换 activePanel；进入游戏（context !== null）后由 App 卸载本组件。
 */
export default function TitleScreen(): JSX.Element {
  // activePanel：当前展开的面板（点击主菜单按钮切换；再点同一项收起）
  const [activePanel, setActivePanel] = useState<ActivePanel>(null)

  // store 订阅：底部状态条 + 展开区组件复用
  const config = useGameStore((s) => s.config)
  const hasConfig = useGameStore((s) => s.hasConfig)
  const savesCount = useGameStore((s) => s.saves.length)
  const busy = useGameStore((s) => s.busy)
  // 第 5 批：直达创建战役独立页（App 第四态 creatorPage）
  const setCreatorPageActive = useGameStore((s) => s.setCreatorPageActive)

  // LLM 状态文案：已配置显示 model，未配置显示「未配置（mock 模式）」
  const llmStatusText = config ? config.model : '未配置（mock 模式）'
  const llmOnline = hasConfig && config !== null

  // 主菜单点击：切换展开/收起（点同一项再收起）
  const togglePanel = (panel: Exclude<ActivePanel, null>): void => {
    setActivePanel((cur) => (cur === panel ? null : panel))
  }

  return (
    <div className="title-screen" role="main" aria-label="标题屏主菜单">
      {/* 全屏背景层（扫描线 + 网格 + 径向光晕，独立叠加，比 body 更浓） */}
      <div className="title-screen__bg" aria-hidden="true" />

      {/* 中央内容区：logo + 主菜单 + 展开区 */}
      <div className="title-screen__content">
        {/* —— 大 logo —— */}
        <header className="title-screen__logo">
          <h1 className="title-screen__logo-en">CYBER WAR SIMULATOR</h1>
          <p className="title-screen__logo-cn">赛博战争模拟器</p>
          <div className="title-screen__logo-tag" aria-hidden="true">
            ▰ LLM 驱动 · 硬核大战略 · Agent + 导演部 ▰
          </div>
        </header>

        {/* —— 主菜单按钮 —— */}
        <nav className="title-screen__menu" aria-label="主菜单">
          {/* 第 5 批：LLM 生成战役 —— 直达创建战役独立页（App 第四态 creatorPage） */}
          <button
            type="button"
            className="title-screen__menu-btn title-screen__menu-btn--primary"
            onClick={() => setCreatorPageActive(true)}
            disabled={busy}
          >
            <Sparkles className="title-screen__menu-icon" />
            <span className="title-screen__menu-label">LLM 生成战役</span>
            <span className="title-screen__menu-sub">自然语言需求 → 七文件 → 开局</span>
          </button>

          <button
            type="button"
            className={
              'title-screen__menu-btn' +
              (activePanel === 'campaign' ? ' title-screen__menu-btn--active' : '')
            }
            onClick={() => togglePanel('campaign')}
            disabled={busy}
            aria-expanded={activePanel === 'campaign'}
          >
            <Play className="title-screen__menu-icon" />
            <span className="title-screen__menu-label">内置/导入战役</span>
            <span className="title-screen__menu-sub">凡尔登默认包 / 导入 ZIP</span>
          </button>

          <button
            type="button"
            className={
              'title-screen__menu-btn' +
              (activePanel === 'saves' ? ' title-screen__menu-btn--active' : '')
            }
            onClick={() => togglePanel('saves')}
            disabled={busy}
            aria-expanded={activePanel === 'saves'}
          >
            <FolderOpen className="title-screen__menu-icon" />
            <span className="title-screen__menu-label">继续存档</span>
            <span className="title-screen__menu-sub">
              {savesCount > 0 ? `${savesCount} 个存档可选` : '暂无存档'}
            </span>
          </button>

          <button
            type="button"
            className={
              'title-screen__menu-btn' +
              (activePanel === 'settings' ? ' title-screen__menu-btn--active' : '')
            }
            onClick={() => togglePanel('settings')}
            disabled={busy}
            aria-expanded={activePanel === 'settings'}
          >
            <Settings className="title-screen__menu-icon" />
            <span className="title-screen__menu-label">设置</span>
            <span className="title-screen__menu-sub">
              {llmOnline ? config!.model : '配置 LLM'}
            </span>
          </button>
        </nav>

        {/* —— 展开区（按 activePanel 切换；进入游戏后 App 卸载本组件） —— */}
        {activePanel !== null && (
          <section className="title-screen__panel-area" aria-live="polite">
            {/* 顶部标签 + 关闭按钮 */}
            <div className="title-screen__panel-header">
              <span className="title-screen__panel-title">
                {activePanel === 'campaign' && '新战役'}
                {activePanel === 'saves' && '继续存档'}
                {activePanel === 'settings' && '设置 · LLM 配置'}
              </span>
              <button
                type="button"
                className="title-screen__panel-close"
                onClick={() => setActivePanel(null)}
                aria-label="收起面板"
              >
                ✕
              </button>
            </div>

            {/* 复用现有组件（不重写逻辑）：CampaignPanel / SaveListPanel / LLMConfigPanel */}
            <div className="title-screen__panel-body">
              {activePanel === 'campaign' && <CampaignPanel />}
              {activePanel === 'saves' && <SaveListPanel />}
              {activePanel === 'settings' && <LLMConfigPanel />}
            </div>
          </section>
        )}
      </div>

      {/* —— 底部状态条 —— */}
      <footer className="title-screen__statusbar" aria-label="状态条">
        <span className="title-screen__status-item">
          <span
            className={
              'title-screen__status-dot' +
              (llmOnline
                ? ' title-screen__status-dot--on'
                : ' title-screen__status-dot--off')
            }
          />
          LLM {llmOnline ? 'ONLINE' : 'OFFLINE'}
        </span>
        <span className="title-screen__status-item title-screen__status-model">
          {llmStatusText}
        </span>
        <span className="title-screen__status-spacer" />
        <span className="title-screen__status-item title-screen__status-version">
          {APP_VERSION}
        </span>
      </footer>
    </div>
  )
}

/**
 * 全屏沙盘弹窗（SandboxOverlay.tsx）— UI 重构第 1 批「全对话为主」。
 *
 * 右栏 MiniSandbox 点击后弹出此 modal，内嵌完整 Sandbox（PixiJS 大沙盘）供玩家
 * 详细查看战场/选单位。点击遮罩或右上「关闭」按钮回退到小沙盘。
 *
 * 设计：
 * - fixed 全屏遮罩（半透明深空蓝底 + backdrop-filter blur）。
 * - 中央卡片承载 Sandbox（最大 90vw × 90vh），赛博朋克青光描边 + 四角 HUD。
 * - ESC 键关闭（无障碍）。
 *
 * 不 import @tauri-apps/api（UI 层）。
 *
 * @module layers/ui/sandbox/SandboxOverlay
 */

import { useEffect, type JSX } from 'react'
import Sandbox from './Sandbox'
import SandboxErrorBoundary from './SandboxErrorBoundary'
import UnitDetailPanel from '@/layers/ui/units/UnitDetailPanel'

/**
 * 全屏沙盘弹窗组件。
 *
 * @param open 是否显示
 * @param onClose 关闭回调（点遮罩/关闭按钮/ESC 时调用）
 */
export default function SandboxOverlay({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element | null {
  // ESC 键关闭（无障碍 + 快捷）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="sandbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="战场沙盘（全屏）"
      onClick={onClose}
    >
      <div
        className="sandbox-overlay__card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sandbox-overlay__header">
          <h2 className="sandbox-overlay__title">战场沙盘</h2>
          <button
            type="button"
            className="sandbox-overlay__close"
            onClick={onClose}
            aria-label="关闭全屏沙盘"
          >
            ✕
          </button>
        </div>
        <div className="sandbox-overlay__body">
          {/* SandboxErrorBoundary：隔离沙盘崩溃，防止传播到 modal 整体 */}
          <SandboxErrorBoundary>
            <Sandbox />
          </SandboxErrorBoundary>
          {/* 单位详情浮层（选中单位时覆盖沙盘右上）——全屏沙盘才显示详情，
              对话为主布局下中栏是对话流，详情跟随沙盘放此 overlay 内。 */}
          <UnitDetailPanel />
        </div>
      </div>
    </div>
  )
}

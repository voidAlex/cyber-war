/**
 * 沙盘错误边界（SandboxErrorBoundary.tsx）— 包裹 Sandbox 的 React error boundary。
 *
 * 职责（双保险）：
 * - 即使 Sandbox 内部某处抛出未捕获的同步/渲染异常，本边界把它隔离在沙盘区域内，
 *   显示「沙盘加载失败」占位 + 错误摘要（dev 可见），**绝不让 Sandbox 崩溃
 *   传播到整个应用**（否则主界面其余面板：存档/命令/战报/日志全部被 React 卸载）。
 * - 与 Sandbox.tsx 内部的 async init try/catch 互为兜底：
 *   · Sandbox 内 try/catch 处理 init/destroy 的异步错误（降级占位）。
 *   · 本边界处理渲染期/同步期抛出的异常（React 子树隔离）。
 *
 * 设计约束：
 * - class 组件（React error boundary 必须用 class 实现 getDerivedStateFromError / componentDidCatch）。
 * - 不 import @tauri-apps/api（Sandbox 也不 import；gateway 唯一）。
 * - dev 环境显示错误 message 摘要；生产环境只显示通用占位，避免泄露内部细节。
 *
 * @module layers/ui/sandbox/SandboxErrorBoundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
// 注：原 fallbackStyle（占位内联样式）已抽到 styles.css 的
// .sandbox--error / .sandbox__placeholder / .sandbox__placeholder-* 类名。

/** 沙盘错误边界 Props。 */
export interface SandboxErrorBoundaryProps {
  /** 子节点（通常是 <Sandbox />）。 */
  children: ReactNode
}

/** 沙盘错误边界 State。 */
interface SandboxErrorBoundaryState {
  /** 是否捕获到错误。true 时渲染占位。 */
  hasError: boolean
  /** 错误 message（dev 展示）。 */
  message: string
}

/**
 * 沙盘错误边界组件。
 *
 * 用法：
 * ```tsx
 * <SandboxErrorBoundary>
 *   <Sandbox />
 * </SandboxErrorBoundary>
 * ```
 */
export default class SandboxErrorBoundary extends Component<
  SandboxErrorBoundaryProps,
  SandboxErrorBoundaryState
> {
  state: SandboxErrorBoundaryState = { hasError: false, message: '' }

  /**
   * 渲染期抛错时触发：返回新 state 让组件降级渲染占位。
   * 注意：仅在子树渲染抛错时调用；事件回调、async 错误不会走这里。
   */
  static getDerivedStateFromError(error: Error): SandboxErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message ?? String(error),
    }
  }

  /**
   * 捕获错误后副作用：console.error 留痕（dev 排查用）。
   * 不在这里做副作用清理（Sandbox 自己的 effect cleanup 负责 Pixi 资源释放）。
   */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[sandbox-error-boundary] Sandbox crashed, isolated:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="panel sandbox sandbox--error">
          <h2 className="panel__title">战场沙盘</h2>
          <div className="sandbox__placeholder">
            <p className="sandbox__placeholder-title">沙盘加载失败</p>
            {/* dev 环境显示错误摘要，方便排查；生产环境隐藏 */}
            {import.meta.env.DEV && this.state.message.length > 0 && (
              <p className="sandbox__placeholder-message">{this.state.message}</p>
            )}
            <p className="sandbox__placeholder-detail">其余面板不受影响，可继续指挥。</p>
          </div>
        </section>
      )
    }
    return this.props.children
  }
}

/**
 * 可折叠面板区（CollapsibleSection）— 左栏面板折叠/展开包装。
 *
 * 解决真机问题3：左栏 280px 塞 5 个面板纵向拥挤溢出。每个面板用本组件包裹，
 * header 点击切换展开/收起；折叠态只显示紧凑标题条（节省纵向空间），
 * 展开态显示完整 children（面板主体）。
 *
 * 设计：
 * - header 是一个可点击的标题条（含折叠箭头 + 标题），青光描边呼应主题。
 * - 折叠态：仅 header（高度约 32px）；展开态：header + children。
 * - defaultOpen 控制初始态；左栏策略：存档/回合默认展开，其余默认收起。
 * - 不修改被包裹 panel 的内部结构（children 是完整 panel 组件）。
 *
 * 无障碍：header 用 button + aria-expanded，键盘可达。
 *
 * @module layers/ui/CollapsibleSection
 */

import { useState, type ReactNode, type JSX } from 'react'

export interface CollapsibleSectionProps {
  /** header 标题文本（折叠/展开态都显示） */
  title: string
  /** 面板主体（展开时渲染） */
  children: ReactNode
  /** 初始是否展开（默认 true） */
  defaultOpen?: boolean
  /** 折叠态额外摘要（可选，显示在标题右侧，如「3 个存档」） */
  collapsedHint?: string
}

/**
 * 可折叠面板区组件。
 */
export default function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  collapsedHint,
}: CollapsibleSectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`collapsible ${open ? 'collapsible--open' : 'collapsible--closed'}`}>
      <button
        type="button"
        className="collapsible__header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`collapsible__arrow ${open ? 'collapsible__arrow--open' : ''}`}>
          {open ? '▼' : '▶'}
        </span>
        <span className="collapsible__title">{title}</span>
        {!open && collapsedHint !== undefined && collapsedHint.length > 0 && (
          <span className="collapsible__hint">{collapsedHint}</span>
        )}
      </button>
      {open && <div className="collapsible__body">{children}</div>}
    </div>
  )
}

/**
 * 战术决策面板（DecisionPanel.tsx）— 第 3 批战役机制。
 *
 * 职责（对应重写计划「第 3 批：战术决策树」）：
 * - decision 阶段：读取 context.pendingDecision，渲染战术决策
 *   （label + description + 选项卡片，每个选项含后果摘要）。
 * - 玩家点选某选项 → 调 store.resolveDecision(optionId, overrides)，
 *   完成本回合（decision → persist → idle → NEXT_TURN）。
 * - 玩家点"跳过"→ store.resolveDecision(null, [])，无后果直接落盘。
 *
 * 赛博朋克风格：青光描边选项卡片 + hover 高亮 + 角装饰。
 * 后果展示：每个选项列出 overrides 的 reason（数值变化摘要，不暴露 field 路径）。
 *
 * @module layers/ui/DecisionPanel
 */

import { useState, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { AlertTriangle } from '@/layers/ui/icons'
import type { TacticalDecisionOption } from '@/types'
import type { DirectorOverride } from '@/layers/agents/protocol/schema'

/**
 * 战术决策面板组件。
 *
 * 从 store.context.pendingDecision 读取当前待决策，渲染选项卡片。
 * 玩家选择后调 store.resolveDecision；跳过按钮调 resolveDecision(null, [])。
 */
export default function DecisionPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const resolveDecision = useGameStore((s) => s.resolveDecision)
  // 本地状态：玩家选中但未确认的选项 id（高亮预览）；null=未选
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)

  if (context === null) {
    return (
      <section className="panel decision-panel">
        <h2 className="panel__title">战术决策</h2>
        <p className="decision-panel__empty">请先创建或载入存档。</p>
      </section>
    )
  }

  const decision = context.pendingDecision

  if (!decision) {
    return (
      <section className="panel decision-panel">
        <h2 className="panel__title">战术决策</h2>
        <p className="decision-panel__empty">当前无待解决的战术决策。</p>
      </section>
    )
  }

  // 当前选中选项（用于确认按钮显示 + 后果预览）
  const selectedOption =
    selectedOptionId !== null
      ? decision.options.find((o) => o.id === selectedOptionId) ?? null
      : null

  /** 处理玩家选择某选项：先本地选中（高亮），再确认时 resolveDecision。 */
  const handleConfirm = (): void => {
    if (selectedOption) {
      void resolveDecision(selectedOption.id, selectedOption.overrides)
    } else {
      // 未选中任何选项 → 视为跳过（无后果）
      void resolveDecision(null, [])
    }
  }

  /** 处理跳过：无后果直接落盘。 */
  const handleSkip = (): void => {
    setSelectedOptionId(null)
    void resolveDecision(null, [])
  }

  return (
    <section className="panel decision-panel">
      <h2 className="panel__title">
        <span className="decision-panel__title-icon" aria-hidden>
          {/* 三叉戟图标代理"决策/分支"语义（用 AlertTriangle 旋转代理，避免新依赖） */}
          <AlertTriangle size={16} aria-hidden />
        </span>
        战术决策 — 第 {decision.turn + 1} 天
      </h2>

      <div className="decision-panel__header">
        <h3 className="decision-panel__label">{decision.label}</h3>
        <p className="decision-panel__description">{decision.description}</p>
      </div>

      <ul className="decision-panel__options">
        {decision.options.map((opt) => (
          <DecisionOptionCard
            key={opt.id}
            option={opt}
            selected={selectedOptionId === opt.id}
            onSelect={() => setSelectedOptionId(opt.id)}
            disabled={busy}
          />
        ))}
      </ul>

      <div className="decision-panel__actions">
        <button
          type="button"
          className="decision-panel__confirm"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? '处理中…' : selectedOption ? `确认：${selectedOption.label}` : '确认选择'}
        </button>
        <button
          type="button"
          className="decision-panel__skip"
          onClick={handleSkip}
          disabled={busy}
        >
          跳过（无后果）
        </button>
      </div>

      <p className="decision-panel__hint">
        选择后将立即应用后果并进入下一回合；跳过则维持现状。
      </p>
    </section>
  )
}

/**
 * 决策选项卡片（赛博朋克青光描边）。
 *
 * - 选中态：青光描边加粗 + 背景高亮。
 * - hover 态：描边变亮（CSS hover 实现）。
 * - 后果预览：列出 overrides 的 reason（人类可读），不暴露 field 路径。
 */
function DecisionOptionCard({
  option,
  selected,
  onSelect,
  disabled,
}: {
  option: TacticalDecisionOption
  selected: boolean
  onSelect: () => void
  disabled: boolean
}): JSX.Element {
  return (
    <li
      className={
        'decision-panel__option' +
        (selected ? ' decision-panel__option--selected' : '')
      }
    >
      <button
        type="button"
        className="decision-panel__option-button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
      >
        <span className="decision-panel__option-label">{option.label}</span>
        <span className="decision-panel__option-description">{option.description}</span>
        {/* 后果摘要：列出每条 override 的 reason + 数值变化（精简） */}
        {option.overrides.length > 0 && (
          <ul className="decision-panel__option-overrides">
            {option.overrides.map((ov, i) => (
              <OverrideSummary key={`${option.id}-${i}`} override={ov} />
            ))}
          </ul>
        )}
      </button>
    </li>
  )
}

/**
 * 单条后果摘要：显示数值变化（before → after）+ reason。
 *
 * before/after 可能是数字或占位符（已被导演部解析为具体数值）。
 * 此处仅展示，不修改。
 */
function OverrideSummary({ override }: { override: DirectorOverride }): JSX.Element {
  // 从 field 路径 units.<unitId>.<field> 提取单位 id + 字段名（人类可读摘要）
  const parts = override.field.split('.')
  const unitId = parts.length >= 2 ? parts[1] : override.field
  const field = parts.length >= 3 ? parts.slice(2).join('.') : 'value'

  // 数值变化展示：数字则显示 delta，否则原值
  const beforeStr = formatValue(override.before)
  const afterStr = formatValue(override.after)

  return (
    <li className="decision-panel__override">
      <span className="decision-panel__override-field">
        {unitId}.{field}
      </span>
      <span className="decision-panel__override-delta">
        {beforeStr} → {afterStr}
      </span>
      <span className="decision-panel__override-reason">{override.reason}</span>
    </li>
  )
}

/** 格式化 override 值：数字显示原值，其它显示 JSON 摘要。 */
function formatValue(v: unknown): string {
  if (typeof v === 'number') return String(v)
  if (v === null || v === undefined) return '—'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

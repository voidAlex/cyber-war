/**
 * 信息栏 tab 切换（InfoTabs.tsx）— UI 重构第 1 批「全对话为主」右栏中部。
 *
 * 五个 tab：部队 ForcesPanel / 情报 IntelligencePanel / 外交 DiplomacyPanel /
 *          后勤 SupplyPanel / 决策 DecisionHistoryPanel。
 * 默认显示「部队」（玩家最常用：点单位看详情）。
 *
 * 复用现有四个 Panel 组件（不重写）+ 新增 SupplyPanel/DecisionHistoryPanel，
 * 仅在外层包 tab 切换容器。
 *
 * 不 import @tauri-apps/api（UI 层）。
 *
 * @module layers/ui/InfoTabs
 */

import { useState, type JSX } from 'react'
import IntelligencePanel from './IntelligencePanel'
import DiplomacyPanel from './DiplomacyPanel'
import ForcesPanel from './ForcesPanel'
import SupplyPanel from './SupplyPanel'
import DecisionHistoryPanel from './DecisionHistoryPanel'

/** tab id */
type TabId = 'forces' | 'intel' | 'diplomacy' | 'supply' | 'decisions'

/** tab 配置（顺序即显示顺序） */
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'forces', label: '部队' },
  { id: 'intel', label: '情报' },
  { id: 'diplomacy', label: '外交' },
  { id: 'supply', label: '后勤' },
  { id: 'decisions', label: '决策' },
]

/**
 * 信息栏 tab 组件（右栏中部）。
 *
 * @param defaultTab 默认 tab（默认 forces）
 */
export default function InfoTabs({ defaultTab = 'forces' }: { defaultTab?: TabId }): JSX.Element {
  const [active, setActive] = useState<TabId>(defaultTab)

  return (
    <section className="panel info-tabs" aria-label="信息栏">
      <div className="info-tabs__bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            className={'info-tabs__tab' + (active === t.id ? ' info-tabs__tab--active' : '')}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="info-tabs__body">
        {active === 'forces' && <ForcesPanel />}
        {active === 'intel' && <IntelligencePanel />}
        {active === 'diplomacy' && <DiplomacyPanel />}
        {active === 'supply' && <SupplyPanel />}
        {active === 'decisions' && <DecisionHistoryPanel />}
      </div>
    </section>
  )
}

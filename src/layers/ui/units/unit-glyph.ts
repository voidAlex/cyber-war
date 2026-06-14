/**
 * 单位类型标识常量（unit-glyph.ts）— UnitDetailPanel / ForcesPanel / SandboxRenderer 共用。
 *
 * 抽到独立文件避免 React 组件文件同时导出组件 + 常量（react-refresh 警告）。
 *
 * @module layers/ui/units/unit-glyph
 */

import type { UnitType } from '@/types'

/** 单位类型中文短名（标题/类型标签用）。 */
export const UNIT_TYPE_NAMES: Record<UnitType, string> = {
  infantry: '步兵',
  armor: '装甲',
  artillery: '炮兵',
  recon: '侦察',
  fortress: '要塞',
  support: '后勤',
}

/** 单位类型单字标识（沙盘军标旁标 + 列表 glyph 圆徽共用）。 */
export const UNIT_TYPE_GLYPH: Record<UnitType, string> = {
  infantry: '步',
  armor: '装',
  artillery: '炮',
  recon: '侦',
  fortress: '塞',
  support: '勤',
}

/**
 * 统一图标封装（icons/index.tsx）— 基于 lucide-react。
 *
 * 设计目的：
 * - 用 SVG 图标（lucide）替换散落的 emoji（🔑⏱📡⚙⚠ 等），可染色、跨平台一致。
 * - 提供两种用法：
 *   1. 按名查表：<Icon name="alert-triangle" className="..." size={16} />
 *   2. 直接具名导入：import { AlertTriangle } from '@/layers/ui/icons'
 *
 * 染色：lucide 图标默认 stroke="currentColor"，故只需外层 className 设 color 即可染色。
 *
 * @module layers/ui/icons
 */

import {
  AlertTriangle,
  KeyRound,
  Clock,
  Wifi,
  Settings,
  RefreshCw,
  Play,
  ChevronDown,
  Activity,
  Zap,
  Radio,
  Terminal,
  ShieldAlert,
  X,
  Cpu,
  Database,
  Lock,
  Unlock,
  CheckCircle2,
  XCircle,
  type LucideProps,
} from 'lucide-react'
import { type JSX } from 'react'

/** 具名导出常用图标（直接用 lucide 组件，className 染色、size 控制大小）。 */
export {
  AlertTriangle,
  KeyRound,
  Clock,
  Wifi,
  Settings,
  RefreshCw,
  Play,
  ChevronDown,
  Activity,
  Zap,
  Radio,
  Terminal,
  ShieldAlert,
  X,
  Cpu,
  Database,
  Lock,
  Unlock,
  CheckCircle2,
  XCircle,
}

/**
 * 图标名 → lucide 组件映射表。
 * key 用 kebab-case，便于 JSX 中以字符串引用。
 */
const ICON_MAP = {
  'alert-triangle': AlertTriangle,
  'key-round': KeyRound,
  clock: Clock,
  wifi: Wifi,
  settings: Settings,
  'refresh-cw': RefreshCw,
  play: Play,
  'chevron-down': ChevronDown,
  activity: Activity,
  zap: Zap,
  radio: Radio,
  terminal: Terminal,
  'shield-alert': ShieldAlert,
  x: X,
  cpu: Cpu,
  database: Database,
  lock: Lock,
  unlock: Unlock,
  'check-circle': CheckCircle2,
  'x-circle': XCircle,
} as const

/** 图标名（kebab-case）。 */
export type IconName = keyof typeof ICON_MAP

/** Icon 组件 props（透传 lucide，额外接受 name）。 */
export interface IconProps extends Omit<LucideProps, 'ref'> {
  /** 图标名（kebab-case，见 ICON_MAP）。 */
  name: IconName
}

/**
 * 按名渲染图标的统一组件。
 *
 * 用法：
 * ```tsx
 * <Icon name="alert-triangle" size={18} className="error-banner__icon" />
 * ```
 *
 * 染色：外层 className 设 color（lucide 用 currentColor）。
 */
export function Icon({ name, ...rest }: IconProps): JSX.Element {
  const Cmp = ICON_MAP[name] ?? AlertTriangle
  return <Cmp aria-hidden="true" {...rest} />
}

export default Icon

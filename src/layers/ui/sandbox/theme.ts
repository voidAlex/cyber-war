/**
 * 沙盘主题（theme.ts）— 地形/阵营/线条配色常量，纯数据无副作用。
 *
 * 【UI-B 赛博朋克对齐】配色与 DOM 层 styles.css 的 `:root` token 保持同源：
 * 全息青蓝（--accent-cyan #06B6D4 / --accent-blue #3B82F6）+ 深空蓝底（--bg-void #0A0E1A）。
 * 因 CSS 变量无法喂给 PIXI Graphics.fill，此处用对应 hex 常量复制一份（注释标注同源 token）。
 *
 * 阵营色以 faction.color（hex 字符串，数据驱动）为准；本文件只提供地形底色与
 * 通用线条色。faction.color 由数据驱动，渲染时直接消费（默认包：法蓝 #2563EB / 德灰 #6B7280，
 * 与青蓝族谱协调，无需改数据）。
 *
 * @module layers/ui/sandbox/theme
 */

import type { TerrainType } from '@/types'

/**
 * 地形底色（hex，PIXI Graphics fill 用）。
 *
 * 【赛博朋克】暗化为深空蓝族谱：平原/道路偏冷蓝灰、森林暗青绿、山地深褐、
 * 水域冷青蓝、城镇建筑灰、要塞深褐（高防）、沼泽暗青。低饱和让阵营色单位更突出。
 */
export const TERRAIN_COLORS: Record<TerrainType, number> = {
  plain: 0x1e293b, // 平原：深石板蓝（对应 --bg-item #1E293B）
  forest: 0x14532d, // 森林：暗青绿（赛博暗化）
  mountain: 0x44403c, // 山地：深褐灰
  water: 0x0e3a5f, // 水域：冷青蓝（与底色青蓝族谱协调）
  urban: 0x3f3f46, // 城镇：建筑灰
  fortress: 0x27272a, // 要塞：深石（极高防御加成，最暗）
  marsh: 0x134e4a, // 沼泽：暗青绿（高移动消耗）
}

/** 未知/兜底地形底色（理论不会命中，仅防御）。 */
export const TERRAIN_FALLBACK_COLOR = 0x1e293b

/**
 * 网格线颜色（青光半透明）。
 * 【同源】rgba(6,182,212,0.3) → 0x06B6D4（--accent-cyan），alpha 由 GRID_LINE_ALPHA 给。
 */
export const GRID_LINE_COLOR = 0x06b6d4

/** 网格线透明度（0..1，青光网格保持 0.3 微亮，不抢主体）。 */
export const GRID_LINE_ALPHA = 0.3

/** 网格线宽度（像素）。 */
export const GRID_LINE_WIDTH = 1

/** 坐标标签颜色（青亮，在暗底地形上对比清晰）。 */
export const LABEL_COLOR = 0x06b6d4

/** 坐标标签透明度（暗底上稍降，避免与单位争夺视线）。 */
export const LABEL_ALPHA = 0.4

/**
 * 高价值节点星标颜色（金色）。
 * 【同源】--warn #F59E0B（金）。
 */
export const OBJECTIVE_COLOR = 0xf59e0b

/** 高价值节点边框颜色（金暗，对比金填充）。 */
export const OBJECTIVE_BORDER_COLOR = 0xb45309

/** 高价值节点标记透明度。 */
export const OBJECTIVE_ALPHA = 0.95

/**
 * 预演虚线颜色（青光）。
 * 【同源】--accent-cyan #06B6D4（原橙黄 0xffb020 已废）。
 */
export const PREVIEW_LINE_COLOR = 0x06b6d4

/** 预演虚线透明度（青光醒目）。 */
export const PREVIEW_LINE_ALPHA = 0.9

/** 预演虚线宽度。 */
export const PREVIEW_LINE_WIDTH = 2

/** 预演虚线段长（像素）。 */
export const PREVIEW_DASH_LENGTH = 6

/** 预演虚线间隔（像素）。 */
export const PREVIEW_GAP_LENGTH = 4

/**
 * 侦察（recon）预演虚线颜色（蓝）。
 * 【同源】--accent-blue #3B82F6，与移动预演青光 #06B6D4 区分：
 * 移动/占领用青虚线，侦察用蓝虚线，玩家一眼区分命令类型。
 */
export const RECON_LINE_COLOR = 0x3b82f6

/** 侦察预演虚线透明度（与移动预演一致，醒目）。 */
export const RECON_LINE_ALPHA = 0.9

/** 侦察预演虚线宽度（与移动预演一致）。 */
export const RECON_LINE_WIDTH = 2

/** 选中 cell 高亮描边色（青亮）。 */
export const SELECTED_COLOR = 0x06b6d4

/** 悬停 cell 高亮描边色（青亮）。 */
export const HOVER_COLOR = 0x06b6d4

/** 高亮填充透明度。 */
export const HIGHLIGHT_ALPHA = 0.18

/** 高亮描边透明度。 */
export const HIGHLIGHT_STROKE_ALPHA = 0.9

/** 单位军标默认描边色（与阵营填充对比的黑边，暗底上保留深黑）。 */
export const UNIT_BORDER_COLOR = 0x0a0e1a

/** 单位军标描边宽度。 */
export const UNIT_BORDER_WIDTH = 1.5

// ===== 情报 4 级渲染配色（M4-B，赛博青蓝色阶）=====

/** L1 热力脉冲填充透明度（模糊色块，半透明）。 */
export const HEAT_PULSE_FILL_ALPHA = 0.32

/** L1 热力脉冲外圈描边透明度（暗示「热力」）。 */
export const HEAT_PULSE_RING_ALPHA = 0.5

/**
 * L2 编制确认虚线边框色（青亮，对应 --accent-cyan）。
 * 【原白 0xf5f5f5 改青亮】L2 用青虚线暗示「已确认编制但未全量」，与 L0 盲区(不可见)→
 * L1 暗青热力 → L2 青虚线 → L3 阵营色实心的青蓝色阶一致。
 */
export const INTEL_DASH_COLOR = 0x06b6d4

/** L2 编制确认虚线描边宽度。 */
export const INTEL_DASH_WIDTH = 1.5

/**
 * 残影标签 [T-Nh] 文本颜色（青淡，对应 rgba(6,182,212,0.2) 近似的暗青）。
 * 【原暖灰 0xd4a04a 改青淡】与赛博青蓝基调统一，暗示信息已过期（暗一档）。
 */
export const GHOST_LABEL_COLOR = 0x0e7490

/** 强度条背景色（深底，对应 --bg-void #0A0E1A 系）。 */
export const STRENGTH_BAR_BG = 0x0a0e1a

/** 强度条前景色：高强度青绿（--success #10B981）/ 低强度红（--danger #EF4444）。 */
export const STRENGTH_COLOR_HIGH = 0x10b981
export const STRENGTH_COLOR_LOW = 0xef4444

/**
 * 阵营色解析：faction.color 为 hex 字符串（如 "#3B82F6"），
 * 转 PIXI 用的 number（0x3b82f6）。非法/缺失返回青灰兜底（与赛博底协调）。
 */
export function factionColorToNumber(hex: string | undefined): number {
  if (typeof hex !== 'string') return 0x06b6d4
  const trimmed = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return 0x06b6d4
  return parseInt(trimmed, 16)
}

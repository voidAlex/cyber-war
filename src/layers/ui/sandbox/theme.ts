/**
 * 沙盘主题（theme.ts）— 地形/阵营/线条配色常量，纯数据无副作用。
 *
 * 配色采用低饱和度军图风格（便于阵营色单位与高价值节点标记突出）。
 * 阵营色以 faction.color（hex 字符串）为准；本文件只提供地形底色与
 * 通用线条色。faction.color 由数据驱动，渲染时直接消费。
 *
 * @module layers/ui/sandbox/theme
 */

import type { TerrainType } from '@/types'

/**
 * 地形底色（hex，PIXI Graphics fill 用）。
 *
 * 选择低饱和度，避免与单位阵营色冲突。水域/沼泽偏冷蓝，森林/山地偏深，
 * 平原/道路偏亮，城镇/要塞用建筑灰。
 */
export const TERRAIN_COLORS: Record<TerrainType, number> = {
  plain: 0xa8b88a, // 平原：浅黄绿
  forest: 0x4a6b3a, // 森林：深绿
  mountain: 0x7a6a52, // 山地：褐灰
  water: 0x4a6f8a, // 水域：冷蓝（不可通行/渡河惩罚）
  urban: 0x8a7a6a, // 城镇：建筑褐灰
  fortress: 0x6a5a4a, // 要塞：深褐（极高防御加成）
  marsh: 0x5a7a6a, // 沼泽：暗青绿（高移动消耗）
}

/** 未知/兜底地形底色（理论不会命中，仅防御）。 */
export const TERRAIN_FALLBACK_COLOR = 0xcccccc

/** 网格线颜色（半透明深灰）。 */
export const GRID_LINE_COLOR = 0x2a2a2a

/** 网格线透明度（0..1）。 */
export const GRID_LINE_ALPHA = 0.35

/** 网格线宽度（像素）。 */
export const GRID_LINE_WIDTH = 1

/** 坐标标签颜色（深色，与浅底地形对比）。 */
export const LABEL_COLOR = 0x222222

/** 坐标标签透明度。 */
export const LABEL_ALPHA = 0.55

/** 高价值节点星标颜色（金色）。 */
export const OBJECTIVE_COLOR = 0xf5c542

/** 高价值节点边框颜色。 */
export const OBJECTIVE_BORDER_COLOR = 0xb8860b

/** 高价值节点标记透明度。 */
export const OBJECTIVE_ALPHA = 0.95

/** 预演虚线颜色（玩家阵营默认橙黄）。 */
export const PREVIEW_LINE_COLOR = 0xffb020

/** 预演虚线透明度。 */
export const PREVIEW_LINE_ALPHA = 0.85

/** 预演虚线宽度。 */
export const PREVIEW_LINE_WIDTH = 2

/** 预演虚线段长（像素）。 */
export const PREVIEW_DASH_LENGTH = 6

/** 预演虚线间隔（像素）。 */
export const PREVIEW_GAP_LENGTH = 4

/** 选中 cell 高亮描边色。 */
export const SELECTED_COLOR = 0xffffff

/** 悬停 cell 高亮描边色。 */
export const HOVER_COLOR = 0xffffff

/** 高亮填充透明度。 */
export const HIGHLIGHT_ALPHA = 0.18

/** 高亮描边透明度。 */
export const HIGHLIGHT_STROKE_ALPHA = 0.9

/** 单位军标默认描边色（与阵营填充对比的黑边）。 */
export const UNIT_BORDER_COLOR = 0x111111

/** 单位军标描边宽度。 */
export const UNIT_BORDER_WIDTH = 1.5

/** 强度条背景色（深底）。 */
export const STRENGTH_BAR_BG = 0x1a1a1a

/** 强度条前景色（绿→红按强度变化，渲染时按比例插值）。 */
export const STRENGTH_COLOR_HIGH = 0x4caf50
export const STRENGTH_COLOR_LOW = 0xe53935

/**
 * 阵营色解析：faction.color 为 hex 字符串（如 "#3B82F6"），
 * 转 PIXI 用的 number（0x3b82f6）。非法/缺失返回灰色兜底。
 */
export function factionColorToNumber(hex: string | undefined): number {
  if (typeof hex !== 'string') return 0x9e9e9e
  const trimmed = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return 0x9e9e9e
  return parseInt(trimmed, 16)
}

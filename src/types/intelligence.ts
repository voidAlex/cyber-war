/**
 * 情报系统类型定义
 *
 * 统一四级语义：Level 0=盲区 / Level 1=热力脉冲 / Level 2=编制确认 / Level 3=全量透视。
 * **数大=清晰**（沿用 PRD §6 语义），types 与实现一律按此。
 *
 * 关键草案（PRD「情报 4 级」）：
 * - 半衰期草案 halfLifeTurns=3，recon 命中刷新 lastSeenTurn。
 * - 超半衰降级并显示残影 + [T-Nh] 标记。
 *
 * @module types/intelligence
 */

/**
 * 情报清晰度级别（数大=清晰）
 *
 * - L0 盲区：完全无信息
 * - L1 热力脉冲：仅知道存在，无编制/数量
 * - L2 编制确认：知道单位类型与大致数量
 * - L3 全量透视：完整透视（己方单位默认 / 满情报）
 */
export type IntelLevel = 0 | 1 | 2 | 3

/** 基础情报级别常量（语义别名，便于可读性） */
export const INTEL_LEVEL_BLIND = 0 satisfies IntelLevel // 盲区
export const INTEL_LEVEL_HEAT_PULSE = 1 satisfies IntelLevel // 热力脉冲
export const INTEL_LEVEL_FORMATION_CONFIRMED = 2 satisfies IntelLevel // 编制确认
export const INTEL_LEVEL_FULL_PENETRATION = 3 satisfies IntelLevel // 全量透视

/**
 * 某阵营对某目标的情报观测记录。
 *
 * 一个 Unit 的 detection 字段按 factionId 索引此结构。
 */
export interface IntelObservation {
  /** 观测方阵营 id */
  observerFactionId: string
  /** 当前情报级别（0-3） */
  level: IntelLevel
  /** 最后一次被侦察命中/刷新的回合索引 */
  lastSeenTurn: number
  /**
   * 残影回合数：当前回合 - lastSeenTurn。
   * 超过半衰期（halfLifeTurns）应降级并标记残影。
   * 注意：此字段在持久化时可重算，由 domain/intelligence 维护。
   */
  staleTurns: number
}

/**
 * 情报半衰期规则（草案参数，挂载在战役 rules.json 或全局配置）。
 */
export interface IntelDecayRule {
  /** 半衰回合数（草案 3） */
  halfLifeTurns: number
  /** 降级规则：每过一个半衰期降低的级别 */
  decayPerHalfLife: number
}

/**
 * 默认情报衰减规则草案（halfLifeTurns=3）。
 * domain/intelligence 在无战役自定义规则时使用。
 */
export const DEFAULT_INTEL_DECAY_RULE: IntelDecayRule = {
  halfLifeTurns: 3,
  decayPerHalfLife: 1,
}

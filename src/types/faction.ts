/**
 * 阵营类型定义
 *
 * 定义游戏中的阵营/势力，含「人格数值基底」CommanderProfile。
 * 重写计划修订点 C：CommanderProfile 加 aggression/obedience/preferredTempo/doctrineTags
 * 数值字段，使人格有数值锚，非纯随机漂移。
 *
 * @module types/faction
 */

import type { DiplomacyTrust } from './diplomacy'

/**
 * 阵营立场（决定控制方与外交倾向）。
 *
 * - player：玩家阵营（玩家控制）
 * - enemy：敌方阵营（AI 控制，敌对）
 * - ally：盟友阵营（AI 控制，但与玩家友好）
 * - neutral：中立阵营（AI 控制，不参战）
 *
 * 第 5 批：FactionSide 保持 4 值（粗粒度立场，决定控制权），
 * 细粒度的两两关系（A 对 B 敌对 / 对 C 中立）改由 `faction.relations` 表达，
 * 多阵营战役包无需塞进 4 值分类。
 */
export type FactionSide = 'player' | 'enemy' | 'ally' | 'neutral'

/**
 * 两阵营间关系（第 5 批多阵营支撑）。
 *
 * - hostile：敌对（敌意明确，可能随时开战，但当前未正式交战）
 * - at_war：交战（正在作战，受规则引擎当作敌方结算）
 * - allied：结盟（友好同盟，互不攻击，可协同）
 * - neutral：中立（无特殊关系，互不干涉）
 *
 * 与 `trust` 数值并行：trust 是 0..100 的连续信任度（用于外交趋势推断），
 * relations 是离散定性关系（用于结算/着色/参战判定）。
 * 缺省关系为 'neutral'；player-enemy 阵营默认应为 'at_war'。
 */
export type FactionRelation = 'hostile' | 'at_war' | 'allied' | 'neutral'

/**
 * 指挥官人格数值基底（重写计划修订点 C）。
 *
 * LLM 在数值约束内发挥；obedience 低时 director 按概率判抗命。
 * 所有数值字段为 0..1 的归一化值（domain 层负责语义解释）。
 */
export interface CommanderProfile {
  /** 指挥官唯一标识 */
  id: string
  /** 姓名 */
  name: string
  /** 自然语言人格描述（L0 system prompt 稳定前缀的一部分） */
  personality: string
  /** 进攻性（0=保守 .. 1=激进） */
  aggression: number
  /** 服从度（0=易抗命 .. 1=绝对服从），低于阈值时 director 按概率判抗命 */
  obedience: number
  /** 偏好节奏（methodical/rapid/balanced），影响 LLM 决策倾向 */
  preferredTempo: CommanderTempo
  /** 学说标签（如「消耗战」「机动穿插」），供规则引擎与 prompt 引用 */
  doctrineTags: string[]
}

/** 指挥官偏好节奏 */
export type CommanderTempo = 'methodical' | 'balanced' | 'rapid'

/**
 * 阵营后勤/资源状态（对应 PRD 左侧看板）。
 */
export interface FactionSupply {
  /** 综合物资（0..100，影响维持/补给） */
  supplies: number
  /** 弹药储备（0..100） */
  ammunition: number
  /** 燃料储备（0..100，影响机动单位） */
  fuel: number
}

/**
 * 阵营接口。
 *
 * 代表游戏中的一个势力/阵营，包含最高统帅人格、战区司令列表、
 * 后勤与对外信任度（trust 按 factionId 索引到对方）。
 */
export interface Faction {
  /** 阵营唯一标识符 */
  id: string
  /** 阵营显示名 */
  name: string
  /** 阵营颜色（十六进制，如 #3B82F6），用于沙盘染色 */
  color: string
  /** 阵营立场（player/enemy/ally/neutral） */
  side: FactionSide
  /** 最高统帅人格（决定全局决策基调） */
  commander: CommanderProfile
  /** 战区司令人格列表（各战区独立决策，可空） */
  theaterCommanders: CommanderProfile[]
  /** 后勤资源状态 */
  supply: FactionSupply
  /**
   * 对外信任度：key=对方 factionId，value=信任度 0..100。
   * 详细记录见 DiplomacyTrust，此处仅存数值用于快速渲染。
   */
  trust: Record<string, number>
  /**
   * 对外定性关系（第 5 批多阵营支撑）：key=对方 factionId，
   * value=FactionRelation（hostile/at_war/allied/neutral）。
   *
   * 与 `trust` 并行——`trust` 是连续数值（外交趋势），`relations` 是离散定性
   * （结算/着色/参战判定）。缺失某 key 时由 domain 兜底为 'neutral'。
   * 可选字段：旧存档/无多阵营关系的战役可省略。
   */
  relations?: Record<string, FactionRelation>
  /**
   * 对外信任度富语义记录（M4-D 外交趋势持久化）：key=对方 factionId。
   *
   * 与 `trust` 数值并行——`trust` 保留快速渲染数值，`trustRecords` 持久化
   * honoredCount/brokenCount/lastChangeTurn/stance 等趋势推断所需字段。
   * 缺失某 key 时由 domain/infrastructure 兜底构造（以 `trust` 数值 + 默认 stance）。
   * 可选字段：旧存档/无外交交互的阵营可省略。
   */
  trustRecords?: Record<string, DiplomacyTrust>
  /** 学说标签（阵营级，汇总各指挥官 doctrineTags） */
  doctrineTags: string[]
  /** 阵营描述（可选） */
  description?: string
}

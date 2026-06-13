/**
 * 外交系统类型定义
 *
 * 外交信任度 0..100：
 * - 盟友 60 / 中立 50 / 敌对 5 起步
 * - 履约 +5~10、毁约 -15~25
 * - <30 盟友请求拒绝率陡升，<15 可能倒戈（director 随机事件）
 *
 * @module types/diplomacy
 */

/**
 * 外交关系分类（决定信任度初值与行为倾向）。
 */
export type DiplomaticStance = 'ally' | 'neutral' | 'enemy' | 'war'

/** 各关系分类的信任度初值草案（PRD「外交信任度」） */
export const INITIAL_TRUST_BY_STANCE: Record<DiplomaticStance, number> = {
  ally: 60,
  neutral: 50,
  enemy: 5,
  war: 0,
}

/**
 * 一对阵营之间的外交信任度记录（双向，以「观察方 → 对方」方向存储）。
 *
 * 信任度数值范围 0..100。
 */
export interface DiplomacyTrust {
  /** 信任度数值（0-100） */
  trust: number
  /** 关系分类 */
  stance: DiplomaticStance
  /** 累计履约次数（用于 diagnostics / 可观测） */
  honoredCount: number
  /** 累计毁约次数 */
  brokenCount: number
  /** 最近一次信任度变动所属的回合索引 */
  lastChangeTurn: number
}

/**
 * 一次外交事件（履约 / 毁约 / 倒戈），写入 event-log 供回放与导演部参考。
 */
export interface DiplomacyEvent {
  /** 所属回合 */
  turn: number
  /** 发起方阵营 id */
  fromFactionId: string
  /** 对方阵营 id */
  toFactionId: string
  /** 事件类别 */
  kind: 'honor' | 'break' | 'defect'
  /** 信任度变动量（正为履约增益，负为毁约/倒戈扣减） */
  delta: number
  /** 变动后信任度 */
  trustAfter: number
}

/**
 * 默认信任度变动草案。
 * domain/diplomacy 在无战役自定义规则时使用。
 */
export const DEFAULT_DIPLOMACY_DELTAS = {
  /** 履约增益（+5~10，取上界草案） */
  honor: 8,
  /** 毁约扣减（-15~25，取下界草案） */
  break: -20,
} as const

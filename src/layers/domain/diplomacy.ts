/**
 * 外交信任度（diplomacy.ts）— 纯函数。
 *
 * 信任度 0..100：
 * - 起步：盟友 60 / 中立 50 / 敌对 5（见 types/diplomacy INITIAL_TRUST_BY_STANCE）
 * - 履约 +5~10、毁约 -15~25
 * - <30 盟友请求拒绝率陡升；<15 可能倒戈（director 随机事件）
 *
 * 全纯函数。director/规则引擎调用 applyTrustChange/拒绝率/倒戈判定推进外交。
 *
 * @module layers/domain/diplomacy
 */

import type { DiplomacyTrust, DiplomacyEvent, DiplomaticStance } from '@/types'

/** 信任度下限（恒定） */
export const TRUST_MIN = 0
/** 信任度上限（恒定） */
export const TRUST_MAX = 100

/** 拒绝率陡升阈值（<30） */
export const REJECT_RATE_THRESHOLD = 30
/** 可能倒戈阈值（<15） */
export const DEFECTION_THRESHOLD = 15

/** 拒绝率线性模型：信任度=阈值时拒绝率 0.2，信任度=0 时拒绝率 1.0 */
export const REJECT_RATE_AT_THRESHOLD = 0.2

/**
 * 钳制信任度到 [0, 100]。
 */
export function clampTrust(value: number): number {
  return Math.max(TRUST_MIN, Math.min(TRUST_MAX, value))
}

/**
 * 基础信任度变动计算（保留兼容既有 barrel 导出）。
 *
 * 仅做钳制，不改变 stance/计数。富语义变更用 applyHonor/applyBreak。
 *
 * @param current 当前信任度
 * @param delta 变动量（正为履约增益，负为毁约扣减）
 * @returns 钳制后信任度
 */
export function applyTrustChange(current: number, delta: number): number {
  return clampTrust(current + delta)
}

/**
 * 履约：信任度 +5~10，更新 honoredCount/lastChangeTurn。
 *
 * @param trust 原信任度记录
 * @param turn 当前回合
 * @param delta 履约增益（默认取草案上界 8）
 */
export function applyHonor(
  trust: DiplomacyTrust,
  turn: number,
  delta = 8,
): { trust: DiplomacyTrust; delta: number } {
  const newTrustValue = clampTrust(trust.trust + delta)
  return {
    trust: {
      ...trust,
      trust: newTrustValue,
      honoredCount: trust.honoredCount + 1,
      lastChangeTurn: turn,
    },
    delta,
  }
}

/**
 * 毁约：信任度 -15~25，更新 brokenCount/lastChangeTurn。
 *
 * @param trust 原信任度记录
 * @param turn 当前回合
 * @param delta 毁约扣减（默认取草案下界 -20；取绝对值越大扣越多）
 */
export function applyBreak(
  trust: DiplomacyTrust,
  turn: number,
  delta = -20,
): { trust: DiplomacyTrust; delta: number } {
  const newTrustValue = clampTrust(trust.trust + delta)
  return {
    trust: {
      ...trust,
      trust: newTrustValue,
      brokenCount: trust.brokenCount + 1,
      lastChangeTurn: turn,
    },
    delta,
  }
}

/**
 * 计算盟友请求拒绝率（0..1）。
 *
 * 数值假设：
 * - 信任度 >= REJECT_RATE_THRESHOLD(30)：拒绝率 = REJECT_RATE_AT_THRESHOLD(0.2)
 * - 信任度 < 30：线性下降，trust=0 时拒绝率=1.0
 *
 * @param trustValue 当前信任度数值
 */
export function computeRejectRate(trustValue: number): number {
  if (trustValue >= REJECT_RATE_THRESHOLD) {
    return REJECT_RATE_AT_THRESHOLD
  }
  // 线性插值：30→0.2，0→1.0
  const slope = (1.0 - REJECT_RATE_AT_THRESHOLD) / (REJECT_RATE_THRESHOLD - 0)
  return Math.min(1, Math.max(0, 1.0 - slope * trustValue))
}

/**
 * 倒戈概率（0..1）。
 *
 * 数值假设：
 * - 信任度 >= DEFECTION_THRESHOLD(15)：倒戈概率 0
 * - 信任度 < 15：线性上升，trust=0 时倒戈概率 0.8（留 0.2 余地给 director 随机事件）
 *
 * @param trustValue 当前信任度数值
 */
export function computeDefectionProbability(trustValue: number): number {
  if (trustValue >= DEFECTION_THRESHOLD) {
    return 0
  }
  // 线性插值：15→0，0→0.8
  const slope = 0.8 / DEFECTION_THRESHOLD
  return Math.min(0.8, Math.max(0, slope * (DEFECTION_THRESHOLD - trustValue)))
}

/**
 * 是否处于倒戈风险区（信任度 < 15）。
 */
export function isAtDefectionRisk(trustValue: number): boolean {
  return trustValue < DEFECTION_THRESHOLD
}

/**
 * 根据信任度推断关系分类（用于 UI 渲染与 director 提示）。
 *
 * 数值假设：
 * - >=60：ally
 * - 30..59：neutral
 * - 15..29：enemy
 * - <15：war（敌对且可能倒戈）
 */
export function inferStance(trustValue: number): DiplomaticStance {
  if (trustValue >= 60) return 'ally'
  if (trustValue >= 30) return 'neutral'
  if (trustValue >= 15) return 'enemy'
  return 'war'
}

/**
 * 构造一条外交事件记录（写入 event-log，供回放/director 参考）。
 *
 * @param turn 回合
 * @param fromFactionId 发起方
 * @param toFactionId 对方
 * @param kind 事件类别
 * @param delta 变动量
 * @param trustAfter 变动后信任度
 */
export function buildDiplomacyEvent(
  turn: number,
  fromFactionId: string,
  toFactionId: string,
  kind: DiplomacyEvent['kind'],
  delta: number,
  trustAfter: number,
): DiplomacyEvent {
  return { turn, fromFactionId, toFactionId, kind, delta, trustAfter }
}

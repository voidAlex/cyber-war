/**
 * 外交请求流程（diplomacy-request.ts）— 纯函数。
 *
 * 玩家自然语言外交请求（如「请求盟友空中支援」）→ 盟友统帅（commander Agent）
 * 响应 accept / reject / flake（掉链子）→ 信任度变化（履约 +8 / 毁约 -20）。
 *
 * 数值假设（PRD §4 盟友外交 + diplomacy.ts）：
 * - 接受率受信任度影响：trust<30 拒绝率陡升（computeRejectRate）。
 * - flake（答应却掉链子）：信任度越低越可能掉链子（obedience 低）。
 * - 履约：applyHonor（+8）；毁约（含 flake）：applyBreak（-20）。
 *
 * 本模块纯逻辑：给定「盟友是否响应」的输入（由 commander Agent / 规则引擎
 * 决策），产出信任度变化 + 事件记录。commander Agent 接入在 CommandTerminal /
 * orchestrator 层，本模块负责把响应映射成外交结果。
 *
 * @module layers/domain/diplomacy-request
 */

import {
  applyHonor,
  applyBreak,
  computeRejectRate,
  computeDefectionProbability,
  isAtDefectionRisk,
  buildDiplomacyEvent,
} from '@/layers/domain/diplomacy'
import type {
  DiplomacyTrust,
  DiplomacyEvent,
  Faction,
  // T3-A：DiplomaticRequestKind/DiplomaticRequest 已上移到 types 契约层
  // （types/diplomacy.ts，含新增 'threat'）。本文件 re-export 以保留旧 import 路径。
  DiplomaticRequestKind,
  DiplomaticRequest,
} from '@/types'

// T3-A：re-export types 契约层定义，保留 domain barrel 旧导出路径不变。
export type { DiplomaticRequestKind, DiplomaticRequest }

/**
 * 盟友统帅对玩家请求的响应类别。
 *
 * - accept：答应并履约（信任度 +8）
 * - reject：直接拒绝（信任度不变；拒绝率随 trust 下降而上升）
 * - flake：答应却掉链子（信任度 -20，信任度越低越易发生）
 */
export type DiplomaticResponseType = 'accept' | 'reject' | 'flake'

/**
 * 盟友统帅响应产物（commander Agent 产出或规则引擎模拟）。
 */
export interface DiplomaticResponse {
  /** 请求回指 */
  request: DiplomaticRequest
  /** 响应类别 */
  type: DiplomaticResponseType
  /** 统帅的回应文本（盟友统帅自然语言回复，UI 展示） */
  message: string
  /** 是否抗命（obedience 低；flake 场景常用） */
  disobeying: boolean
}

/**
 * 外交请求结算结果（信任度变化 + 事件 + 可观测提示）。
 */
export interface DiplomaticRequestResult {
  /** 响应回指 */
  response: DiplomaticResponse
  /** 结算后的信任度记录（toFaction 对 fromFaction 方向） */
  trustAfter: DiplomacyTrust
  /** 信任度变动量（accept: +8、reject: 0、flake: -20） */
  delta: number
  /** 写入 event-log 的事件记录 */
  event: DiplomacyEvent
  /** 是否进入倒戈风险区（trustAfter < 15） */
  defectionRisk: boolean
}

/** 履约增益（草案上界） */
export const HONOR_DELTA = 8
/** 毁约扣减（草案下界） */
export const BREAK_DELTA = -20

/**
 * 结算一次外交响应 → 信任度变化 + 事件记录（纯函数）。
 *
 * - accept：applyHonor（+8）、event.kind='honor'
 * - reject：信任度不变、event.kind='honor'（delta=0，仅记录交互）
 * - flake：applyBreak（-20）、event.kind='break'
 *
 * @param trust 盟友对玩家的当前信任度记录（toFaction 视角）
 * @param response 盟友统帅响应
 */
export function resolveDiplomaticResponse(
  trust: DiplomacyTrust,
  response: DiplomaticResponse,
): DiplomaticRequestResult {
  const turn = response.request.turn
  let delta: number
  let kind: DiplomacyEvent['kind']

  switch (response.type) {
    case 'accept':
      delta = applyHonor(trust, turn, HONOR_DELTA).delta
      kind = 'honor'
      break
    case 'flake':
      delta = applyBreak(trust, turn, BREAK_DELTA).delta
      kind = 'break'
      break
    case 'reject':
    default:
      // 拒绝：信任度不变（仅记录交互），delta=0
      delta = 0
      kind = 'honor'
      break
  }

  // 重新计算信任度记录（reject 不变 honoredCount/lastChangeTurn，保持原状 + delta=0）
  const trustAfter: DiplomacyTrust =
    response.type === 'reject'
      ? trust
      : response.type === 'accept'
        ? applyHonor(trust, turn, HONOR_DELTA).trust
        : applyBreak(trust, turn, BREAK_DELTA).trust

  const event = buildDiplomacyEvent(
    turn,
    response.request.fromFactionId,
    response.request.toFactionId,
    kind,
    delta,
    trustAfter.trust,
  )

  return {
    response,
    trustAfter,
    delta,
    event,
    defectionRisk: isAtDefectionRisk(trustAfter.trust),
  }
}

/**
 * 把外交结算结果应用回阵营（更新 faction.trust 数值 + trustRecords 富语义记录）。
 *
 * M4-D 外交趋势持久化：调用方（编排器/CommandTerminal）在 resolveDiplomaticResponse
 * 后调本函数，把 trustAfter（DiplomacyTrust）落回 faction，使 DiplomacyPanel 能
 * 显示真实趋势（computeTrustTrend 读 honoredCount/brokenCount/lastChangeTurn）。
 *
 * 纯函数：返回新 faction（不可变产出），不原地改。
 *
 * @param faction 待更新的阵营（toFaction，即信任度记录的持有方）
 * @param result 外交结算结果（含 trustAfter）
 * @param fromFactionId 信任度的对方（玩家）factionId（trustRecords 的 key）
 * @returns 更新后的新 faction（trust + trustRecords 同步更新）
 */
export function applyDiplomacyResultToFaction(
  faction: Faction,
  result: DiplomaticRequestResult,
  fromFactionId: string,
): Faction {
  const trustValue = result.trustAfter.trust
  const trustRecords = { ...(faction.trustRecords ?? {}) }
  trustRecords[fromFactionId] = result.trustAfter
  return {
    ...faction,
    trust: { ...faction.trust, [fromFactionId]: trustValue },
    trustRecords,
  }
}

/**
 * 基于信任度的响应类别决策（规则引擎模拟，确定性可注入随机源）。
 *
 * 决策流程：
 * 1. 拒绝率 = computeRejectRate(trustValue)；rand < 拒绝率 → reject。
 * 2. flake 概率 = computeDefectionProbability(trustValue) * 0.5（答应后掉链子，
 *    约为倒戈概率的一半，弱化但相关）；rand < flake 概率 → flake。
 * 3. 否则 accept。
 *
 * disobedience 高（盟友统帅抗命）时 flake 概率再上调（×1.5）。
 *
 * @param trustValue 当前信任度数值
 * @param rand 决定性随机数（0..1），由调用方注入（确定性种子）
 * @param disobeying 盟友统帅是否抗命（影响 flake 概率）
 */
export function rollDiplomaticResponse(
  trustValue: number,
  rand: number,
  disobeying = false,
): DiplomaticResponseType {
  const rejectRate = computeRejectRate(trustValue)
  if (rand < rejectRate) return 'reject'

  // flake 概率：倒戈概率的一半，抗命时 ×1.5（上限 0.8）
  let flakeProb = computeDefectionProbability(trustValue) * 0.5
  if (disobeying) flakeProb = Math.min(0.8, flakeProb * 1.5)
  // 即使信任度高，抗命统帅仍有最低 flake 概率（0.1）
  if (disobeying) flakeProb = Math.max(flakeProb, 0.1)

  if (rand < rejectRate + flakeProb) return 'flake'
  return 'accept'
}

/**
 * 外交请求的简短中文描述（UI 卡片标题用）。
 */
export function describeRequestKind(kind: DiplomaticRequestKind): string {
  const map: Record<DiplomaticRequestKind, string> = {
    air_support: '空中支援',
    artillery_support: '炮兵支援',
    reinforcement: '增援请求',
    supply: '物资补给',
    intelligence: '情报共享',
    ceasefire: '停火协商',
    threat: '威胁勒索', // T3-A：NPC 兵力优势时威胁玩家投降
    other: '外交请求',
  }
  return map[kind] ?? '外交请求'
}

/**
 * 从自然语言请求文本推断请求类别（规则匹配，供 commander Agent 上下文与 UI）。
 *
 * 关键词命中即归类；无命中默认 other。
 */
export function inferRequestKind(text: string): DiplomaticRequestKind {
  const lower = text.toLowerCase()
  if (/(空中|空军|战机|空中支援|air)/.test(lower)) return 'air_support'
  if (/(炮兵|炮击|火炮|artillery)/.test(lower)) return 'artillery_support'
  if (/(增援|援军|reinforce)/.test(lower)) return 'reinforcement'
  if (/(补给|物资|弹药|燃料|supply)/.test(lower)) return 'supply'
  if (/(情报|侦察|intelligence)/.test(lower)) return 'intelligence'
  if (/(停火|休战|ceasefire)/.test(lower)) return 'ceasefire'
  return 'other'
}

/**
 * 响应类别的中文标签（UI 卡片结果用）。
 */
export function describeResponseType(type: DiplomaticResponseType): string {
  switch (type) {
    case 'accept':
      return '答应履约'
    case 'reject':
      return '拒绝'
    case 'flake':
      return '答应却掉链子'
    default:
      return type
  }
}

/**
 * 响应类别的语义颜色（UI 卡片边框/图标用）。
 */
export function responseColor(type: DiplomaticResponseType): string {
  switch (type) {
    case 'accept':
      return '#4caf50' // 绿
    case 'reject':
      return '#9e9e9e' // 灰
    case 'flake':
      return '#e53935' // 红
    default:
      return '#9e9e9e'
  }
}

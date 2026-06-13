/**
 * 状态机合法迁移表（transitions.ts）— 纯数据 + 纯函数。
 *
 * 借鉴 src-legacy/game/state-machine.ts 的 VALID_TRANSITIONS 表骨架，
 * 重写时剥离副作用，仅保留「阶段 → 合法目标阶段」的纯映射。
 *
 * 状态机线性链（含失败回路）：
 *   idle → planning → handshake → locked → resolution → briefing → persist → idle
 *   resolution → locked（结算失败回退）
 *   persist → briefing（落盘失败回退）
 *
 * 此表为纯数据，guard.ts 与 reducer.ts 共同消费。
 *
 * @module layers/application/state-machine/transitions
 */

import type { GamePhase } from '@/types'

/**
 * 合法迁移表：源阶段 → 允许迁移到的目标阶段集合。
 *
 * 失败回路（对应重写计划「失败回路 resolution→locked、persist→briefing」）：
 * - resolution 失败可回 locked 重新结算
 * - persist 失败可回 briefing 再次进入持久化
 */
export const VALID_TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  idle: ['planning', 'idle'], // idle→idle（NEXT_TURN 推进回合，保持 idle 阶段）
  planning: ['handshake', 'idle'],
  handshake: ['locked', 'planning'],
  locked: ['resolution'],
  resolution: ['briefing', 'locked'], // resolution → locked 失败回路
  briefing: ['persist'],
  persist: ['idle', 'briefing'], // persist → briefing 失败回路
}

/**
 * 判断从 from 到 to 是否为合法迁移（纯函数，无副作用）。
 *
 * 命名沿用 src-legacy 的 isValidTransition（计划点名借鉴）。
 *
 * @param from 源阶段
 * @param to 目标阶段
 * @returns 是否合法
 */
export function isValidTransition(from: GamePhase, to: GamePhase): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

/** 旧名兼容（部分测试/调用方沿用 canTransition） */
export const canTransition = isValidTransition

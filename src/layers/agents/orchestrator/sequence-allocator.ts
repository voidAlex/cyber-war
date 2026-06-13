/**
 * Agent 编排器 — 确定性 sequence 预分配（orchestrator/sequence-allocator.ts）。
 *
 * 对应重写计划关键防坑「Agent 并发抢序破坏确定性」与 TDD §3.4「确定性 sequence 预分配」：
 *
 * **核心思想**：sequence 在**派发时一次性预分配**，按批次固定段位，
 * **与调度/完成顺序无关**。即使战区与敌盟真并行执行，各 Agent 拿到的
 * sequence 与 seed 仍稳定 → 回放 event-log 哈希一致。
 *
 * 段位规则（与 action-envelope.ts / tech-design §3.4 对齐）：
 * | 批次 | 角色 | 段起点 |
 * |------|------|--------|
 * | 1 | 参谋长 chief（玩家侧） | 0+ |
 * | 2 | 战区司令 theater | 1000+ |
 * | 3 | 敌/盟统帅 commander | 2000+ |
 * | 4 | 导演部 director | 3000+ |
 *
 * 种子：`seedFor(scenarioSeed, turn, sequence) = scenarioSeed + ':' + turn + ':' + sequence`。
 * 物理层确定性只依赖此种子；导演层"记录即真相"（回放读 log 不重算）。
 *
 * 本模块为纯函数：不调随机数/Tauri/fetch/Date.now。
 *
 * @module layers/agents/orchestrator/sequence-allocator
 */

import type { AgentRole, ActionEnvelope } from '@/types'

/** 各角色 sequence 段起点（预分配，与调度顺序无关） */
export const SEQUENCE_BASE = {
  chief: 0,
  theater: 1000,
  commander: 2000,
  director: 3000,
} as const

/**
 * 生成确定性种子（scenarioSeed:turn:seq）。
 *
 * 纯函数，确定性根：相同 (scenarioSeed, turn, sequence) → 相同 seed，
 * 与 Agent 实际执行/完成的调度顺序无关。
 *
 * 这是对审计教训「并发抢序破坏确定性」的直接对策：
 * 并行 Agent 各自拿到**预分配的** sequence，种子由派发决定而非完成决定。
 */
export function makeSeed(scenarioSeed: string, turn: number, sequence: number): string {
  return `${scenarioSeed}:${turn}:${sequence}`
}

/**
 * 确定性种子别名（语义化，对应任务规格中的 `seedFor`）。
 * 与 makeSeed 等价；保留 makeSeed 以兼容已有 import。
 */
export const seedFor = makeSeed

// =============================================================================
// sequence 预分配：派发时一次性分配（确定性根）
// =============================================================================

/**
 * 预分配结果（一个角色的整批 sequence）。
 *
 * - `sequences[i]` 是该批第 i 个任务的 sequence（= SEQUENCE_BASE[role] + i）。
 * - `seeds[i] = seedFor(scenarioSeed, turn, sequences[i])`。
 *
 * 调用方据此给每个 Agent / envelope 写入稳定的 sequence 与 seed，
 * 无需依赖 Agent 完成顺序。
 */
export interface AllocatedSequences {
  /** 角色 */
  role: AgentRole
  /** 该批任务的 sequence 列表（按派发顺序，值固定为 base + index） */
  sequences: number[]
  /** 与 sequences 一一对应的确定性种子 */
  seeds: string[]
}

/**
 * 为某角色的一批任务预分配 sequence（派发时一次性分配）。
 *
 * **确定性保证**：返回的 sequence **仅取决于 (role, count, scenarioSeed, turn)**，
 * 与 Agent 实际执行/完成的调度顺序无关。即便战区/敌盟真并行，各自的 sequence
 * 与 seed 仍稳定 → 回放 event-log 哈希一致。
 *
 * @param role Agent 角色
 * @param count 该批任务数（≥0）
 * @param scenarioSeed 场景固定种子
 * @param turn 回合索引
 * @returns 预分配的 sequences 与 seeds（count=0 时为空数组）
 */
export function allocateSequences(
  role: AgentRole,
  count: number,
  scenarioSeed: string,
  turn: number,
): AllocatedSequences {
  const base = SEQUENCE_BASE[role]
  const sequences: number[] = []
  const seeds: string[] = []
  for (let i = 0; i < count; i++) {
    const seq = base + i
    sequences.push(seq)
    seeds.push(seedFor(scenarioSeed, turn, seq))
  }
  return { role, sequences, seeds }
}

/**
 * 单任务便捷预分配：取某角色批内第 index 个任务的 sequence。
 *
 * 等价于 SEQUENCE_BASE[role] + index，并附带种子。
 * 用于"已知单个任务在批内位置"时快速取号。
 */
export function allocateOne(
  role: AgentRole,
  index: number,
  scenarioSeed: string,
  turn: number,
): { sequence: number; seed: string } {
  const sequence = SEQUENCE_BASE[role] + index
  return { sequence, seed: seedFor(scenarioSeed, turn, sequence) }
}

/**
 * 把预分配的 sequence 写入 envelope（不可变产出）。
 *
 * 用于编排层在派发时把稳定的 sequence 烙进每个 envelope，
 * 物理引擎据此构造 DeterministicRandom(scenarioSeed:turn:sequence) 结算。
 *
 * 注意：ActionEnvelope 无 seed 字段；seed 在落 event-log 的 AgentAction 里写
 * （seed = seedFor(scenarioSeed, envelope.turn, sequence)）。
 */
export function withAllocatedSequence(
  envelope: ActionEnvelope,
  sequence: number,
): ActionEnvelope {
  return { ...envelope, sequence }
}

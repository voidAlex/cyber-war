/**
 * Agent 编排器桩（orchestrator/sequence-allocator.ts）。
 *
 * 对应重写计划关键防坑「Agent 并发抢序破坏确定性」：
 * sequence 派发时预分配——参谋批次(seq 0+) / 战区批次(1000+) /
 * 敌盟批次(2000+) / 导演(3000+)，seed = scenarioSeed:turn:seq，
 * 与调度顺序无关。
 *
 * 里程碑：M3（多 Agent 确定性编排）。
 *
 * @module layers/agents/orchestrator
 */

/** 各角色 sequence 段起点（预分配） */
export const SEQUENCE_BASE = {
  chief: 0,
  theater: 1000,
  commander: 2000,
  director: 3000,
} as const

/**
 * 生成确定性种子（scenarioSeed:turn:seq）。
 * 纯函数，不调随机数。
 */
export function makeSeed(scenarioSeed: string, turn: number, sequence: number): string {
  return `${scenarioSeed}:${turn}:${sequence}`
}

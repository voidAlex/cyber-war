/**
 * sequence-allocator 确定性测试（sequence-allocator.test.ts）。
 *
 * 验证（对应重写计划「确定性 sequence 预分配」「防坑-并发抢序」）：
 * - 分批次预分配：chief 0+ / theater 1000+ / commander 2000+ / director 3000+。
 * - seedFor(scenarioSeed, turn, sequence) = 'scenarioSeed:turn:sequence'。
 * - sequence 在派发时一次性分配，**与调度顺序无关**（确定性根）。
 * - allocateSequences 结果仅取决于 (role, count, scenarioSeed, turn)。
 * - 相同输入两次调用产出相同 sequences（幂等）。
 *
 * @module __tests__/agents/sequence-allocator
 */

import { describe, it, expect } from 'vitest'
import {
  SEQUENCE_BASE,
  makeSeed,
  seedFor,
  allocateSequences,
  allocateOne,
  withAllocatedSequence,
} from '@/layers/agents/orchestrator/sequence-allocator'
import type { ActionEnvelope } from '@/types'

describe('SEQUENCE_BASE — 批次段位', () => {
  it('四类角色段位符合规格（0/1000/2000/3000）', () => {
    expect(SEQUENCE_BASE.chief).toBe(0)
    expect(SEQUENCE_BASE.theater).toBe(1000)
    expect(SEQUENCE_BASE.commander).toBe(2000)
    expect(SEQUENCE_BASE.director).toBe(3000)
  })
})

describe('makeSeed / seedFor — 确定性种子', () => {
  it('seedFor = scenarioSeed:turn:sequence', () => {
    expect(seedFor('verdun-1916', 12, 1003)).toBe('verdun-1916:12:1003')
  })

  it('makeSeed 与 seedFor 等价（别名）', () => {
    expect(makeSeed('s', 5, 7)).toBe(seedFor('s', 5, 7))
  })

  it('相同 (seed, turn, seq) → 相同种子（幂等）', () => {
    expect(seedFor('x', 1, 2)).toBe(seedFor('x', 1, 2))
  })

  it('不同 turn 产出不同种子（不混淆回合）', () => {
    expect(seedFor('s', 1, 0)).not.toBe(seedFor('s', 2, 0))
  })
})

describe('allocateSequences — 批次预分配（确定性根）', () => {
  it('chief 批 3 个任务 → sequences [0,1,2]，seeds 对应', () => {
    const alloc = allocateSequences('chief', 3, 'sc', 5)
    expect(alloc.role).toBe('chief')
    expect(alloc.sequences).toEqual([0, 1, 2])
    expect(alloc.seeds).toEqual(['sc:5:0', 'sc:5:1', 'sc:5:2'])
  })

  it('theater 批 2 个任务 → sequences 从 1000 起', () => {
    const alloc = allocateSequences('theater', 2, 'sc', 5)
    expect(alloc.sequences).toEqual([1000, 1001])
    expect(alloc.seeds).toEqual(['sc:5:1000', 'sc:5:1001'])
  })

  it('commander 批从 2000 起，director 批从 3000 起', () => {
    expect(allocateSequences('commander', 2, 'sc', 0).sequences).toEqual([2000, 2001])
    expect(allocateSequences('director', 2, 'sc', 0).sequences).toEqual([3000, 3001])
  })

  it('count=0 → 空数组', () => {
    expect(allocateSequences('theater', 0, 'sc', 0).sequences).toEqual([])
    expect(allocateSequences('theater', 0, 'sc', 0).seeds).toEqual([])
  })

  it('相同 (role, count, seed, turn) 两次调用产出相同结果（确定性）', () => {
    const a = allocateSequences('theater', 5, 'sc', 7)
    const b = allocateSequences('theater', 5, 'sc', 7)
    expect(a.sequences).toEqual(b.sequences)
    expect(a.seeds).toEqual(b.seeds)
  })

  it('sequence 不依赖调度顺序：即使乱序取用，每个槽位 seed 稳定', () => {
    // 模拟并行场景：两个战区 Agent 各自取第 0、第 1 槽，顺序无关
    const alloc = allocateSequences('theater', 2, 'sc', 3)
    // 无论先取 [1] 还是 [0]，槽位值固定
    const slot1 = alloc.sequences[1]
    const slot0 = alloc.sequences[0]
    expect(slot0).toBe(1000)
    expect(slot1).toBe(1001)
    // 种子由 sequence 决定，不由"第几个取"决定
    expect(seedFor('sc', 3, slot1)).toBe('sc:3:1001')
    expect(seedFor('sc', 3, slot0)).toBe('sc:3:1000')
  })
})

describe('allocateOne — 单任务预分配', () => {
  it('chief 第 0 个 → sequence 0', () => {
    expect(allocateOne('chief', 0, 'sc', 1)).toEqual({ sequence: 0, seed: 'sc:1:0' })
  })

  it('director 第 5 个 → sequence 3005', () => {
    expect(allocateOne('director', 5, 'sc', 2)).toEqual({ sequence: 3005, seed: 'sc:2:3005' })
  })
})

describe('withAllocatedSequence — envelope 写入预分配序号', () => {
  it('覆盖 envelope.sequence，保留其余字段（不可变）', () => {
    const base: ActionEnvelope = {
      turn: 3,
      faction: 'blue',
      agentId: 'theater-1',
      agentRole: 'theater',
      intent: 'move',
      payload: { unitId: 'u1' },
      confidence: 0.7,
      requiresConfirmation: false,
      sequence: 0, // 占位
      state: 'locked',
    }
    const out = withAllocatedSequence(base, 1000)
    expect(out.sequence).toBe(1000)
    // 其余字段不变（不可变产出）
    expect(out.faction).toBe('blue')
    expect(out.intent).toBe('move')
    expect(out.payload).toEqual({ unitId: 'u1' })
    expect(base.sequence).toBe(0) // 原 envelope 未被修改
  })
})

describe('确定性根：sequence 与调度完成顺序无关（审计教训回归）', () => {
  it('模拟并发：战区 + 敌盟并行，各自 sequence 段互不冲突且稳定', () => {
    // 预分配：战区 3 个槽（1000-1002），敌盟 2 个槽（2000-2001）
    const theater = allocateSequences('theater', 3, 'sc', 4)
    const commander = allocateSequences('commander', 2, 'sc', 4)

    // 即便敌盟先完成（调度乱序），sequence 仍按预分配固定
    expect(commander.sequences[0]).toBe(2000)
    expect(theater.sequences[2]).toBe(1002)

    // 两段不冲突
    const allSeqs = [...theater.sequences, ...commander.sequences]
    const unique = new Set(allSeqs)
    expect(unique.size).toBe(allSeqs.length) // 无重复
  })

  it('两段 batch 互不依赖：分别 allocate 结果稳定可复现', () => {
    // 模拟"两次回放"：相同输入两次 allocate，结果一致
    const run1 = {
      theater: allocateSequences('theater', 2, 'sc', 9).sequences,
      commander: allocateSequences('commander', 1, 'sc', 9).sequences,
    }
    const run2 = {
      theater: allocateSequences('theater', 2, 'sc', 9).sequences,
      commander: allocateSequences('commander', 1, 'sc', 9).sequences,
    }
    expect(run1).toEqual(run2)
  })
})

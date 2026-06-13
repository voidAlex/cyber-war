/**
 * 确定性随机（DeterministicRandom）单测。
 *
 * 验证：相同 seed → 相同序列；不同维度 → 不同序列；nextInt/chance/pick 行为正确。
 *
 * @module __tests__/domain/deterministic-random
 */

import { describe, expect, it } from 'vitest'
import {
  DeterministicRandom,
  buildSeed,
} from '@/layers/domain/deterministic-random'

describe('buildSeed', () => {
  it('按 scenarioSeed:turn:sequence 拼接', () => {
    expect(buildSeed('verdun-1916', 12, 1003)).toBe('verdun-1916:12:1003')
  })
})

describe('DeterministicRandom 确定性', () => {
  it('相同种子生成完全相同的序列', () => {
    const a = new DeterministicRandom('verdun-1916:7:1001')
    const b = new DeterministicRandom('verdun-1916:7:1001')

    const seqA = [
      a.nextFloat(),
      a.nextInt(1, 100),
      a.chance(0.5),
      a.nextInt(5, 30),
    ]
    const seqB = [
      b.nextFloat(),
      b.nextInt(1, 100),
      b.chance(0.5),
      b.nextInt(5, 30),
    ]

    expect(seqA).toEqual(seqB)
  })

  it('不同 turn 产生不同序列（同 scenarioSeed）', () => {
    const t1 = new DeterministicRandom('s:1:0')
    const t2 = new DeterministicRandom('s:2:0')
    expect([t1.nextFloat(), t1.nextFloat()]).not.toEqual([
      t2.nextFloat(),
      t2.nextFloat(),
    ])
  })

  it('不同 sequence 产生不同序列（同 scenarioSeed/turn）', () => {
    const s0 = DeterministicRandom.fromSequence('s', 5, 0)
    const s1 = DeterministicRandom.fromSequence('s', 5, 1)
    expect(s0.nextFloat()).not.toBe(s1.nextFloat())
  })

  it('fromSequence 与显式 buildSeed 一致', () => {
    const a = DeterministicRandom.fromSequence('sc', 3, 42)
    const b = new DeterministicRandom(buildSeed('sc', 3, 42))
    expect(a.nextFloat()).toBe(b.nextFloat())
  })
})

describe('DeterministicRandom API', () => {
  it('nextFloat 在 [0,1) 区间', () => {
    const rng = new DeterministicRandom('range-test')
    for (let i = 0; i < 100; i++) {
      const v = rng.nextFloat()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('nextInt 在闭区间且覆盖范围', () => {
    const rng = new DeterministicRandom('int-test')
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const v = rng.nextInt(3, 7)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
      seen.add(v)
    }
    // 确定性 RNG 足够多样，应覆盖全部 5 个值
    expect(seen.size).toBe(5)
  })

  it('nextInt min>max 时自动交换不报错', () => {
    const rng = new DeterministicRandom('swap-test')
    const v = rng.nextInt(10, 5)
    expect(v).toBeGreaterThanOrEqual(5)
    expect(v).toBeLessThanOrEqual(10)
  })

  it('chance 边界：p<=0 恒 false，p>=1 恒 true', () => {
    const rng = new DeterministicRandom('chance-edge')
    expect(rng.chance(0)).toBe(false)
    expect(rng.chance(-1)).toBe(false)
    expect(rng.chance(1)).toBe(true)
    expect(rng.chance(2)).toBe(true)
  })

  it('chance(0.5) 在大样本下接近 0.5', () => {
    const rng = new DeterministicRandom('chance-half')
    let trues = 0
    const N = 2000
    for (let i = 0; i < N; i++) if (rng.chance(0.5)) trues++
    const ratio = trues / N
    // 确定性 RNG 均匀性允许 ±10% 误差
    expect(ratio).toBeGreaterThan(0.4)
    expect(ratio).toBeLessThan(0.6)
  })

  it('pick 等概率返回数组元素', () => {
    const rng = new DeterministicRandom('pick-test')
    const items = ['a', 'b', 'c']
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) seen.add(rng.pick(items))
    expect(seen.size).toBe(3)
  })

  it('pick 带权重偏向高权重项', () => {
    const rng = new DeterministicRandom('pick-weighted')
    const items = ['rare', 'common']
    const weights = [1, 99]
    let common = 0
    for (let i = 0; i < 1000; i++) {
      if (rng.pick(items, weights) === 'common') common++
    }
    // common 应占绝大多数（>90%）
    expect(common).toBeGreaterThan(900)
  })

  it('pick 空数组抛错', () => {
    const rng = new DeterministicRandom('pick-empty')
    expect(() => rng.pick([])).toThrow()
  })

  it('pick 单元素数组直接返回', () => {
    const rng = new DeterministicRandom('pick-single')
    expect(rng.pick(['only'])).toBe('only')
  })
})

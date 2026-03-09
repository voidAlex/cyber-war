import { describe, expect, it } from 'vitest'
import { DeterministicRandom } from './deterministic-random'

describe('DeterministicRandom', () => {
  it('固定 seed 与 turnIndex 生成一致随机序列', () => {
    const rngA = new DeterministicRandom('scenario-seed-1', 7)
    const rngB = new DeterministicRandom('scenario-seed-1', 7)

    const seqA = [rngA.next(), rngA.next(), rngA.nextInt(1, 100), rngA.chance(0.5)]
    const seqB = [rngB.next(), rngB.next(), rngB.nextInt(1, 100), rngB.chance(0.5)]

    expect(seqA).toEqual(seqB)
  })

  it('不同 turnIndex 生成不同序列', () => {
    const rngTurn1 = new DeterministicRandom('scenario-seed-1', 1)
    const rngTurn2 = new DeterministicRandom('scenario-seed-1', 2)

    const seq1 = [rngTurn1.next(), rngTurn1.next(), rngTurn1.nextInt(1, 100)]
    const seq2 = [rngTurn2.next(), rngTurn2.next(), rngTurn2.nextInt(1, 100)]

    expect(seq1).not.toEqual(seq2)
  })
})

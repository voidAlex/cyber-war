import { describe, expect, it } from 'vitest'

import { DeterministicRandom } from './deterministic-random'

function generateReplayFingerprint(seed: string, turnIndex: number): string {
  const random = new DeterministicRandom(seed, turnIndex)
  const samples = [
    random.next(),
    random.next(),
    random.nextInt(1, 100),
    Number(random.chance(0.5)),
    random.nextInt(50, 500),
  ]
  return JSON.stringify(samples)
}

describe('replay-regression baseline', () => {
  it('同种子同回合应生成稳定指纹', () => {
    const first = generateReplayFingerprint('scenario-m5-baseline', 11)
    const second = generateReplayFingerprint('scenario-m5-baseline', 11)
    expect(first).toBe(second)
  })

  it('不同回合应生成不同指纹', () => {
    const turn11 = generateReplayFingerprint('scenario-m5-baseline', 11)
    const turn12 = generateReplayFingerprint('scenario-m5-baseline', 12)
    expect(turn11).not.toBe(turn12)
  })
})

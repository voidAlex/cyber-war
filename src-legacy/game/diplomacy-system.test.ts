import { describe, expect, it } from 'vitest'

import type { WorldState, Faction } from '@/types'
import { createEmptyMap } from '@/types'
import { resolveAllyRequest } from './diplomacy-system'

function createWorldState(allyTrust: number): WorldState {
  const ally: Faction = {
    id: 'ally-1',
    name: '盟军第一集团',
    type: 'ally',
    trust: allyTrust,
    color: '#00ffcc',
  }

  return {
    turnIndex: 3,
    factions: [ally],
    units: [],
    map: createEmptyMap(2, 2),
  }
}

describe('diplomacy-system', () => {
  it('同一输入在同一回合内结果可复现', () => {
    const worldState = createWorldState(80)
    const payload = {
      targetFactionId: 'ally-1',
      requestType: 'reinforcement' as const,
      urgency: 'medium' as const,
    }

    const first = resolveAllyRequest(payload, worldState, 'seed-m4')
    const second = resolveAllyRequest(payload, worldState, 'seed-m4')

    expect(first.fulfilled).toBe(second.fulfilled)
    expect(first.probability).toBe(second.probability)
  })

  it('低信任度盟友履约概率更低', () => {
    const lowTrust = resolveAllyRequest(
      { targetFactionId: 'ally-1', requestType: 'reinforcement', urgency: 'medium' },
      createWorldState(20),
      'seed-m4'
    )
    const highTrust = resolveAllyRequest(
      { targetFactionId: 'ally-1', requestType: 'reinforcement', urgency: 'medium' },
      createWorldState(90),
      'seed-m4'
    )

    expect(lowTrust.probability).toBeLessThan(highTrust.probability)
  })
})

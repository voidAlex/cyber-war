import { describe, expect, it } from 'vitest'

import { createEmptyMap } from '@/types'
import type { WorldState } from '@/types'
import { applyIntelligenceDecay, getGhostTimestampLabel } from './intelligence-system'

function createWorldStateWithTimestamp(hoursAgo: number): WorldState {
  const map = createEmptyMap(1, 1)
  const now = Date.now()
  map.cells[0][0] = {
    ...map.cells[0][0],
    fogLevel: 0,
    unitId: 'enemy-1',
    intelligenceTimestamp: now - hoursAgo * 60 * 60 * 1000,
  }

  return {
    turnIndex: 1,
    factions: [],
    units: [],
    map,
  }
}

describe('intelligence-system', () => {
  it('24小时内情报降至Level1', () => {
    const state = createWorldStateWithTimestamp(10)
    const next = applyIntelligenceDecay(state)
    expect(next.map.cells[0][0].fogLevel).toBe(1)
  })

  it('48小时内情报降至Level2', () => {
    const state = createWorldStateWithTimestamp(40)
    const next = applyIntelligenceDecay(state)
    expect(next.map.cells[0][0].fogLevel).toBe(2)
  })

  it('72小时内保留残影并记录时间戳', () => {
    const state = createWorldStateWithTimestamp(60)
    const next = applyIntelligenceDecay(state)
    expect(next.map.cells[0][0].fogLevel).toBe(2)
    expect(next.map.cells[0][0].ghostUnitId).toBe('enemy-1')
    expect(typeof next.map.cells[0][0].ghostTimestamp).toBe('number')
  })

  it('超过72小时进入Level3并清理残影', () => {
    const state = createWorldStateWithTimestamp(80)
    const next = applyIntelligenceDecay(state)
    expect(next.map.cells[0][0].fogLevel).toBe(3)
    expect(next.map.cells[0][0].ghostUnitId).toBeUndefined()
  })

  it('残影标签格式正确', () => {
    const now = Date.now()
    const label = getGhostTimestampLabel(now - 26 * 60 * 60 * 1000, now)
    expect(label).toBe('T-26h')
  })
})

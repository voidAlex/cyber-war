import { describe, expect, it } from 'vitest'

import type { ResolutionEvent } from './state-machine'
import { createResolutionResultFromEventLog } from './use-game-state'

describe('use-game-state event-log replay', () => {
  it('应从导演部终裁信封恢复回合结算结果', () => {
    const events: ResolutionEvent[] = [
      {
        id: 'event-1',
        type: 'envelope_agent_status',
        description: '参谋长处理中',
        data: {
          envelope: {
            kind: 'agent_status',
          },
        },
      },
      {
        id: 'event-2',
        type: 'envelope_director_final',
        description: '导演部终裁',
        data: {
          envelope: {
            payload: {
              turn: 4,
              summary: '导演部：战线稳定推进',
              events: [
                {
                  id: 'resolved-1',
                  type: 'director_summary',
                  description: '导演部总结',
                  data: { source: 'directorate' },
                },
              ],
              stateChanges: {
                director: { summary: '导演部：战线稳定推进' },
              },
            },
          },
        },
      },
    ]

    const replay = createResolutionResultFromEventLog(events)
    expect(replay).not.toBeNull()
    expect(replay?.turn).toBe(4)
    expect(replay?.success).toBe(true)
    expect(replay?.events).toHaveLength(1)
    expect(replay?.events[0]?.type).toBe('director_summary')
  })

  it('缺少导演部终裁信封时应返回 null', () => {
    const events: ResolutionEvent[] = [
      {
        id: 'event-3',
        type: 'envelope_battle_report_chunk',
        description: '战报分片',
        data: {
          envelope: {
            payload: { text: '局部交火持续中' },
          },
        },
      },
    ]

    const replay = createResolutionResultFromEventLog(events)
    expect(replay).toBeNull()
  })
})

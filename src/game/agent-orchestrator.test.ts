import { describe, expect, it, vi } from 'vitest'

import type { AgentAction, WorldState } from '@/types'
import { createEmptyMap } from '@/types'
import type { ResolutionResult } from './state-machine'
import { orchestrateTurnResolution } from './agent-orchestrator'

function createMockWorldState(): WorldState {
  return {
    turnIndex: 6,
    factions: [
      { id: 'player', name: '玩家阵营', type: 'player', trust: 100, color: '#4ade80' },
      { id: 'ally-1', name: '盟军第一集团', type: 'ally', trust: 75, color: '#22d3ee' },
      { id: 'enemy-1', name: '敌军北部战区', type: 'enemy', trust: 0, color: '#f87171' },
    ],
    units: [],
    map: createEmptyMap(8, 8),
  }
}

function createWorkerResult(): ResolutionResult {
  return {
    turn: 7,
    success: true,
    events: [
      {
        id: 'worker-event-1',
        type: 'engagement',
        description: '前线发生接敌',
        data: { source: 'worker' },
      },
    ],
    stateChanges: {
      worker: 'ok',
    },
  }
}

describe('agent-orchestrator', () => {
  it('应产出导演部终裁信封、流式战报分片，并合并盟友响应事件', async () => {
    const responseQueue = [
      JSON.stringify({ summary: '参谋长：风险可控', risks: ['补给线拉长'] }),
      JSON.stringify({ summary: '战区司令：建议右翼牵制', keyActions: ['牵制'], logistics: '可支撑' }),
      JSON.stringify({ summary: '盟军统帅：可协同', intent: 'support', confidence: 0.7 }),
      JSON.stringify({ summary: '敌军统帅：准备反击', intent: 'counter', confidence: 0.6 }),
      JSON.stringify({
        summary: '导演部：\n阶段一，火力试探完成。\n阶段二，主攻方向已形成突破口。',
        additionalEvents: [
          { type: 'weather_shift', description: '天气转阴，空中侦察受限', data: { visibility: 'low' } },
        ],
      }),
    ]

    const sendRequest = vi.fn(async () => {
      const body = responseQueue.shift() ?? JSON.stringify({ summary: '默认输出' })
      return new Response(body, { status: 200 })
    })

    const envelopeCollector: Array<import('@/types').ActionEnvelope> = []
    const confirmedOrders: AgentAction[] = [
      {
        turn: 7,
        faction: 'player',
        agentId: 'chief_of_staff',
        intent: 'request_ally',
        payload: { targetFactionId: 'ally-1' },
        confidence: 0.9,
        requiresConfirmation: true,
        actionId: 'action-request-ally-1',
        timestamp: new Date().toISOString(),
      },
    ]

    const orchestrated = await orchestrateTurnResolution({
      turn: 7,
      saveId: 'save-test-1',
      scenarioSeed: 'scenario-seed-m5',
      worldState: createMockWorldState(),
      pendingOrders: [],
      confirmedOrders,
      workerResult: createWorkerResult(),
      runtimeConfig: {
        provider: 'custom',
        endpoint: 'https://example.test/llm',
        apiKey: 'test-key',
        model: 'test-model',
      },
      sendRequest,
      onEnvelope: envelope => {
        envelopeCollector.push(envelope)
      },
    })

    expect(sendRequest).toHaveBeenCalledTimes(5)
    expect(orchestrated.result.success).toBe(true)

    const finalEnvelope = envelopeCollector.find(envelope => envelope.kind === 'director_final')
    expect(finalEnvelope).toBeDefined()

    const reportChunks = envelopeCollector.filter(envelope => envelope.kind === 'battle_report_chunk')
    expect(reportChunks.length).toBeGreaterThanOrEqual(2)

    const sequenceList = envelopeCollector.map(envelope => envelope.sequence)
    const sortedSequenceList = [...sequenceList].sort((a, b) => a - b)
    expect(sequenceList).toEqual(sortedSequenceList)

    const hasDirectorSummary = orchestrated.result.events.some(event => event.type === 'director_summary')
    expect(hasDirectorSummary).toBe(true)

    const hasWeatherShift = orchestrated.result.events.some(event => event.type === 'weather_shift')
    expect(hasWeatherShift).toBe(true)

    const allySupportEvent = orchestrated.result.events.find(
      event => event.type === 'ally_support_fulfilled' || event.type === 'ally_support_failed'
    )
    expect(allySupportEvent).toBeDefined()
  }, 12000)
})

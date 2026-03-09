import type {
  AgentAction,
  ActionEnvelope,
  DirectorVerdictPayload,
  WorldState,
} from '@/types'
import { generateEventId } from '@/storage'
import type { ResolutionEvent, ResolutionResult } from './state-machine'
import { executeAgentStep } from './action-envelope-executor'
import { resolveAllyRequest } from './diplomacy-system'

interface RuntimeLLMConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  apiKey: string
}

interface OrchestrateTurnResolutionInput {
  turn: number
  saveId: string
  scenarioSeed: string
  settlementBudgetMs?: number
  settlementMaxMs?: number
  contextSummaryByFaction?: Record<string, string>
  worldState: WorldState
  pendingOrders: AgentAction[]
  confirmedOrders: AgentAction[]
  workerResult: ResolutionResult
  runtimeConfig: RuntimeLLMConfig
  sendRequest: (options: {
    provider: RuntimeLLMConfig['provider']
    endpoint: string
    apiKey: string
    payload: Record<string, unknown>
  }) => Promise<Response>
  onEnvelope: (envelope: ActionEnvelope) => void
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function executeAgentStepWithTimeout(input: {
  timeoutMs: number
  fallbackOutput: Record<string, unknown>
  execute: (onEnvelope: (envelope: ActionEnvelope) => void) => Promise<{ output: Record<string, unknown> }>
  pushEnvelope: (envelope: ActionEnvelope) => void
}): Promise<{ output: Record<string, unknown> }> {
  let acceptEnvelope = true
  const guardedOnEnvelope = (envelope: ActionEnvelope) => {
    if (!acceptEnvelope) {
      return
    }
    input.pushEnvelope(envelope)
  }

  const executePromise = input.execute(guardedOnEnvelope)
  const timeoutPromise = wait(input.timeoutMs).then(() => ({ output: input.fallbackOutput }))
  const result = await Promise.race([executePromise, timeoutPromise])
  if (result.output === input.fallbackOutput) {
    acceptEnvelope = false
  }
  return result
}

function splitReportChunks(text: string): string[] {
  const normalized = text.trim()
  if (normalized.length === 0) {
    return ['导演部未返回文本战报，使用系统默认摘要。']
  }

  const chunks = normalized
    .split(/\n+/)
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.length > 0)

  return chunks.length > 0 ? chunks : [normalized]
}

function extractSummary(value: Record<string, unknown>, fallback: string): string {
  const summary = value.summary
  return typeof summary === 'string' && summary.trim().length > 0
    ? summary.trim()
    : fallback
}

export async function orchestrateTurnResolution(input: OrchestrateTurnResolutionInput): Promise<{
  result: ResolutionResult
  envelopes: ActionEnvelope[]
}> {
  const envelopes: ActionEnvelope[] = []
  let sequence = 1
  const pushEnvelope = (envelope: ActionEnvelope) => {
    envelopes.push(envelope)
    input.onEnvelope(envelope)
  }

  const allocateSequence = () => sequence++

  const alliedAndEnemyFactions = input.worldState.factions.filter(
    faction => faction.type === 'enemy' || faction.type === 'ally'
  )
  const contextSummaryByFaction = input.contextSummaryByFaction ?? {}

  const startTimeMs = Date.now()

  const chiefPromise = executeAgentStepWithTimeout({
    timeoutMs: 3500,
    fallbackOutput: {
      summary: '参谋长超时，采用默认风险摘要。',
      risks: ['通信延迟'],
    },
    pushEnvelope,
    execute: onEnvelope => executeAgentStep({
      turn: input.turn,
      factionId: 'player',
      role: 'chief_of_staff',
      agentId: 'chief_of_staff',
      systemInstruction: '你是参谋长。请根据玩家已确认命令生成风险摘要 JSON，字段：summary, risks。',
      payload: {
        turn: input.turn,
        confirmedOrders: input.confirmedOrders,
        pendingOrders: input.pendingOrders,
        scenarioSeed: input.scenarioSeed,
        contextSummary: contextSummaryByFaction.player ?? '',
      },
      runtimeConfig: input.runtimeConfig,
      sendRequest: input.sendRequest,
      allocateSequence,
      onEnvelope,
    }),
  })

  const theaterPromise = executeAgentStepWithTimeout({
    timeoutMs: 3500,
    fallbackOutput: {
      summary: '战区司令超时，采用默认战术计划。',
      keyActions: [],
      logistics: 'unknown',
    },
    pushEnvelope,
    execute: onEnvelope => executeAgentStep({
      turn: input.turn,
      factionId: 'player',
      role: 'theater_commander',
      agentId: 'theater_commander_player',
      systemInstruction: '你是战区司令。请输出 JSON：summary, keyActions, logistics。',
      payload: {
        turn: input.turn,
        confirmedOrders: input.confirmedOrders,
        chiefSummary: null,
        workerEvents: input.workerResult.events,
        contextSummary: contextSummaryByFaction.player ?? '',
      },
      runtimeConfig: input.runtimeConfig,
      sendRequest: input.sendRequest,
      allocateSequence,
      onEnvelope,
    }),
  })

  const [chiefResult, theaterResult] = await Promise.all([chiefPromise, theaterPromise])

  const supremeResultPairs = await Promise.all(alliedAndEnemyFactions.map(async faction => {
    const supremeResult = await executeAgentStepWithTimeout({
      timeoutMs: 3500,
      fallbackOutput: {
        summary: `统帅超时(${faction.id})，采用保守策略。`,
        intent: 'hold',
        confidence: 0.5,
      },
      pushEnvelope,
      execute: onEnvelope => executeAgentStep({
        turn: input.turn,
        factionId: faction.id,
        role: 'supreme_commander',
        agentId: `supreme_commander_${faction.id}`,
        systemInstruction: '你是阵营统帅。请输出 JSON：summary, intent, confidence。',
        payload: {
          turn: input.turn,
          faction,
          workerEvents: input.workerResult.events,
          contextSummary: contextSummaryByFaction[faction.id] ?? '',
        },
        runtimeConfig: input.runtimeConfig,
        sendRequest: input.sendRequest,
        allocateSequence,
        onEnvelope,
      }),
    })

    return {
      factionId: faction.id,
      output: supremeResult.output,
    }
  }))
  const supremeResults: Array<{ factionId: string; output: Record<string, unknown> }> = supremeResultPairs

  const directorResult = await executeAgentStepWithTimeout({
    timeoutMs: 4000,
    fallbackOutput: {
      summary: '导演部超时，采用默认终裁。',
      additionalEvents: [],
    },
    pushEnvelope,
    execute: onEnvelope => executeAgentStep({
      turn: input.turn,
      factionId: 'directorate',
      role: 'director',
      agentId: 'directorate',
      systemInstruction:
        '你是导演部。请输出最终裁定 JSON：summary, additionalEvents（数组，每项含 type/description/data）。',
      payload: {
        turn: input.turn,
        workerResult: input.workerResult,
        chiefSummary: chiefResult.output,
        theaterSummary: theaterResult.output,
        supremeSummaries: supremeResults,
        contextSummary: contextSummaryByFaction.directorate ?? '',
      },
      runtimeConfig: input.runtimeConfig,
      sendRequest: input.sendRequest,
      allocateSequence,
      onEnvelope,
    }),
  })

  const directorSummary = extractSummary(
    directorResult.output,
    '导演部完成裁定，战场态势已更新。'
  )

  const additionalEvents = Array.isArray(directorResult.output.additionalEvents)
    ? directorResult.output.additionalEvents
    : []

  const directorEvents: ResolutionEvent[] = additionalEvents
    .map(item => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const event = item as Record<string, unknown>
      const type = typeof event.type === 'string' ? event.type : 'director_event'
      const description =
        typeof event.description === 'string' && event.description.trim().length > 0
          ? event.description
          : '导演部追加事件'
      const data = event.data && typeof event.data === 'object'
        ? (event.data as Record<string, unknown>)
        : {}

      return {
        id: generateEventId(),
        type,
        description,
        data,
      }
    })
    .filter((event): event is ResolutionEvent => event !== null)

  const mergedEvents: ResolutionEvent[] = [
    ...input.workerResult.events,
    ...directorEvents,
    {
      id: generateEventId(),
      type: 'director_summary',
      description: directorSummary,
      data: {
        source: 'directorate',
      },
    },
  ]

  const allyRequests = input.confirmedOrders.filter(order => order.intent === 'request_ally')
  for (const request of allyRequests) {
    const targetFactionId = typeof request.payload.targetFactionId === 'string'
      ? request.payload.targetFactionId
      : ''
    if (!targetFactionId) {
      continue
    }

    const diplomacy = resolveAllyRequest(
      {
        targetFactionId,
        requestType: 'reinforcement',
        urgency: 'medium',
      },
      input.worldState,
      input.scenarioSeed
    )

    mergedEvents.push({
      id: generateEventId(),
      type: diplomacy.fulfilled ? 'ally_support_fulfilled' : 'ally_support_failed',
      description: diplomacy.reason,
      data: {
        actionId: request.actionId,
        targetFactionId,
        probability: diplomacy.probability,
      },
    })
  }

  const reportChunks = splitReportChunks(directorSummary)
  for (const chunk of reportChunks) {
    pushEnvelope({
      envelopeId: `envelope_report_${generateEventId()}`,
      sequence: allocateSequence(),
      turn: input.turn,
      factionId: 'directorate',
      role: 'director',
      agentId: 'directorate',
      kind: 'battle_report_chunk',
      state: 'streaming',
      payload: { text: chunk },
      timestamp: new Date().toISOString(),
    })
  }

  const verdictPayload: DirectorVerdictPayload = {
    turn: input.turn,
    summary: directorSummary,
    events: mergedEvents,
    stateChanges: {
      worker: input.workerResult.stateChanges,
      director: directorResult.output,
      theater: theaterResult.output,
      supreme: supremeResults,
      chief: chiefResult.output,
    },
  }

  pushEnvelope({
    envelopeId: `envelope_verdict_${generateEventId()}`,
    sequence: allocateSequence(),
    turn: input.turn,
    factionId: 'directorate',
    role: 'director',
    agentId: 'directorate',
    kind: 'director_final',
    state: 'completed',
    payload: verdictPayload,
    timestamp: new Date().toISOString(),
  })

  const elapsedMs = Date.now() - startTimeMs
  const settlementBudgetMs = input.settlementBudgetMs ?? 11000
  const settlementMaxMs = input.settlementMaxMs ?? 15000
  const targetBudgetMs = Math.min(settlementBudgetMs, settlementMaxMs)
  if (elapsedMs < targetBudgetMs) {
    await wait(targetBudgetMs - elapsedMs)
  }

  return {
    envelopes,
    result: {
      turn: input.turn,
      success: true,
      events: mergedEvents,
      stateChanges: verdictPayload.stateChanges,
    },
  }
}

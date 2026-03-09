import type {
  AgentAction,
  ActionEnvelope,
  DirectorVerdictPayload,
  Faction,
} from '@/types'
import { generateEventId } from '@/storage'
import type { ResolutionEvent, ResolutionResult } from './state-machine'
import { executeAgentStep } from './action-envelope-executor'

interface RuntimeLLMConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  apiKey: string
}

interface OrchestrateTurnResolutionInput {
  turn: number
  saveId: string
  scenarioSeed: string
  worldState: {
    factions: Faction[]
  }
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

  const chiefResult = await executeAgentStep({
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
    },
    runtimeConfig: input.runtimeConfig,
    sendRequest: input.sendRequest,
    allocateSequence,
    onEnvelope: pushEnvelope,
  })

  const theaterResult = await executeAgentStep({
    turn: input.turn,
    factionId: 'player',
    role: 'theater_commander',
    agentId: 'theater_commander_player',
    systemInstruction: '你是战区司令。请输出 JSON：summary, keyActions, logistics。',
    payload: {
      turn: input.turn,
      confirmedOrders: input.confirmedOrders,
      chiefSummary: chiefResult.output,
      workerEvents: input.workerResult.events,
    },
    runtimeConfig: input.runtimeConfig,
    sendRequest: input.sendRequest,
    allocateSequence,
    onEnvelope: pushEnvelope,
  })

  const supremeResults: Array<{ factionId: string; output: Record<string, unknown> }> = []
  for (const faction of alliedAndEnemyFactions) {
    const supremeResult = await executeAgentStep({
      turn: input.turn,
      factionId: faction.id,
      role: 'supreme_commander',
      agentId: `supreme_commander_${faction.id}`,
      systemInstruction: '你是阵营统帅。请输出 JSON：summary, intent, confidence。',
      payload: {
        turn: input.turn,
        faction,
        workerEvents: input.workerResult.events,
      },
      runtimeConfig: input.runtimeConfig,
      sendRequest: input.sendRequest,
      allocateSequence,
      onEnvelope: pushEnvelope,
    })

    supremeResults.push({
      factionId: faction.id,
      output: supremeResult.output,
    })
  }

  const directorResult = await executeAgentStep({
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
    },
    runtimeConfig: input.runtimeConfig,
    sendRequest: input.sendRequest,
    allocateSequence,
    onEnvelope: pushEnvelope,
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

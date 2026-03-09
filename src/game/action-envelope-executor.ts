import type { AgentRole, ActionEnvelope } from '@/types'
import { generateEnvelopeId } from '@/types'

interface RuntimeLLMConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  apiKey: string
}

interface ExecuteAgentStepInput {
  turn: number
  factionId: string
  role: AgentRole
  agentId: string
  systemInstruction: string
  payload: Record<string, unknown>
  runtimeConfig: RuntimeLLMConfig
  sendRequest: (options: {
    provider: RuntimeLLMConfig['provider']
    endpoint: string
    apiKey: string
    payload: Record<string, unknown>
  }) => Promise<Response>
  allocateSequence: () => number
  onEnvelope: (envelope: ActionEnvelope) => void
}

function safeParseJSON(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { summary: '' }
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : { summary: trimmed }
  } catch {
    return { summary: trimmed }
  }
}

export interface ExecuteAgentStepResult {
  output: Record<string, unknown>
  rawText: string
}

export async function executeAgentStep(input: ExecuteAgentStepInput): Promise<ExecuteAgentStepResult> {
  const emit = (
    state: ActionEnvelope['state'],
    payload: Record<string, unknown>,
    kind: ActionEnvelope['kind'] = 'agent_status'
  ) => {
    input.onEnvelope({
      envelopeId: generateEnvelopeId(),
      sequence: input.allocateSequence(),
      turn: input.turn,
      factionId: input.factionId,
      role: input.role,
      agentId: input.agentId,
      kind,
      state,
      payload,
      timestamp: new Date().toISOString(),
    })
  }

  emit('running', { phase: 'started' })

  try {
    const response = await input.sendRequest({
      provider: input.runtimeConfig.provider,
      endpoint: input.runtimeConfig.endpoint,
      apiKey: input.runtimeConfig.apiKey,
      payload: {
        messages: [
          { role: 'system', content: input.systemInstruction },
          { role: 'user', content: JSON.stringify(input.payload) },
        ],
        temperature: 0.2,
      },
    })

    const rawText = await response.text()
    const output = safeParseJSON(rawText)
    emit('completed', { phase: 'completed' })
    return { output, rawText }
  } catch (error) {
    emit('failed', {
      phase: 'failed',
      error: error instanceof Error ? error.message : 'agent step failed',
    })
    throw error
  }
}

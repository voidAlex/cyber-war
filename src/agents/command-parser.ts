import type { AgentAction, AgentIntent } from '@/types'
import { fetchLLM } from '@/utils/api-client'

interface ParseCommandInput {
  command: string
  turn: number
  faction: string
  apiKey: string
  endpoint: string
  model: string
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
}

interface ParsedCommandPayload {
  intent?: AgentIntent
  units?: string[]
  targetNode?: string
  confidence?: number
  requiresConfirmation?: boolean
  reason?: string
}

function createActionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function extractJSON(raw: string): ParsedCommandPayload | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed) as ParsedCommandPayload
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as ParsedCommandPayload
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeIntent(intent?: AgentIntent): AgentIntent {
  if (!intent) {
    return 'hold'
  }
  return intent
}

export async function parseNaturalLanguageCommand(input: ParseCommandInput): Promise<AgentAction> {
  const systemInstruction = `你是军事参谋解析器。请把玩家命令解析为 JSON，不要输出其他文字。\nJSON 字段: intent, units, targetNode, confidence, requiresConfirmation, reason。\nintent 必须是: move, deploy, retreat, attack, attack_node, capture_node, defend, scout, recon, resupply, repair, heal, request_ally, negotiate, hold, custom` 

  const response = await fetchLLM({
    provider: input.provider,
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    payload: {
      model: input.model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: input.command },
      ],
      temperature: 0.1,
    },
  })

  const raw = await response.text()
  const parsed = extractJSON(raw)

  const units = parsed?.units && parsed.units.length > 0 ? parsed.units : ['unit-1']
  const targetNode = parsed?.targetNode ?? 'C3'

  return {
    turn: input.turn,
    faction: input.faction,
    agentId: 'chief_of_staff',
    intent: normalizeIntent(parsed?.intent),
    payload: {
      units,
      node: targetNode,
    },
    confidence: parsed?.confidence ?? 0.7,
    requiresConfirmation: parsed?.requiresConfirmation ?? true,
    actionId: createActionId('order'),
    description: parsed?.reason ?? `命令解析：${input.command}`,
    timestamp: new Date().toISOString(),
  }
}

import type { Faction, WorldState } from '@/types'
import { DeterministicRandom } from './engine/deterministic-random'

export interface AllyRequestPayload {
  targetFactionId: string
  requestType: 'air_support' | 'resupply' | 'reinforcement' | 'intel_share'
  urgency: 'low' | 'medium' | 'high'
}

export interface AllyRequestResolution {
  fulfilled: boolean
  probability: number
  reason: string
}

export function resolveAllyRequest(
  payload: AllyRequestPayload,
  worldState: WorldState,
  scenarioSeed: string
): AllyRequestResolution {
  const allyFaction = worldState.factions.find(faction => faction.id === payload.targetFactionId)
  if (!allyFaction || allyFaction.type !== 'ally') {
    return {
      fulfilled: false,
      probability: 0,
      reason: '目标阵营不是有效盟友',
    }
  }

  const baseTrust = normalizeTrust(allyFaction)
  const urgencyModifier = payload.urgency === 'high' ? -0.15 : payload.urgency === 'medium' ? -0.08 : 0
  const requestModifier = payload.requestType === 'intel_share' ? 0.12 : payload.requestType === 'resupply' ? 0.05 : -0.05
  const probability = clamp(baseTrust + urgencyModifier + requestModifier, 0.05, 0.95)

  const random = new DeterministicRandom(`${scenarioSeed}:ally:${payload.targetFactionId}`, worldState.turnIndex)
  const fulfilled = random.chance(probability)

  return {
    fulfilled,
    probability,
    reason: fulfilled ? '盟友接受请求并按计划履约' : '盟友因战场压力未能按时履约',
  }
}

function normalizeTrust(faction: Faction): number {
  return clamp(faction.trust / 100, 0, 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

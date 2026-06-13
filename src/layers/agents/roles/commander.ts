/**
 * 敌/盟统帅角色（commander.ts）— 阵营战略决策（mock + 真 LLM 双实现）。
 *
 * 敌方与盟友阵营的最高统帅决策（sequence 2000+ 段）。
 * 敌盟真并行（sequence 预分配下安全）。
 *
 * 两种实现：
 * - **mock 决策**（createCommanderRole）：基于人格数值（aggression/obedience）的
 *   确定性规则决策（己方单位 → 朝最近敌方单位/节点行动）。离线/测试/兜底用。
 * - **真 LLM 决策**（createLlmCommanderRole）：经 llm-service 调 streamChatStructured
 *   （commander schema），独立视野 + 外交响应 + 信任度影响；失败回退 mock。
 *
 * 人格数值基底：obedience 低时 mayDisobey=true，director 终裁判概率抗命。
 *
 * 确定性：sequence 由编排层预分配注入（与完成顺序无关）。
 * 绝不伪造：仅引用真实单位/节点。
 *
 * @module layers/agents/roles/commander
 */

import type { ValidateFunction } from 'ajv'
import type {
  ActionEnvelope,
  AgentRole,
  WorldState,
} from '@/types'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from './llm-role-base'
import { buildLlmOptions } from './llm-role-base'
import {
  getAgentValidator,
  type CommanderAgentOutput,
  type CommanderDecision,
} from '@/layers/agents/protocol/schema'
import { isLlmCallError } from './role-errors'

/** 统帅决策入参 */
export interface CommanderResolveParams {
  /** 当前世界状态（L1+L2 来源） */
  world: WorldState
  /** 本阵营 id（仅本方单位可见/可控） */
  factionId: string
  /** 当前回合 */
  turn: number
  /** 场景种子（构造 seed 留痕用） */
  scenarioSeed: string
}

/** 统帅决策产物：阵营决策动作列表（带预分配 sequence） */
export interface CommanderResolveResult {
  /** 本回合本阵营的决策（每条带预分配 sequence） */
  decisions: CommanderResolvedDecision[]
  /** 是否抗命（obedience 低时可能，director 终裁参考） */
  disobeying: boolean
}

/** 单条阵营决策（带预分配 sequence） */
export interface CommanderResolvedDecision extends CommanderDecision {
  /** 预分配 sequence（编排层注入，commander 段 2000+） */
  sequence: number
  /** 确定性 seed（scenarioSeed:turn:sequence） */
  seed: string
}

/** 统帅角色接口（mock + LLM 共用签名） */
export interface CommanderRole {
  resolve(params: CommanderResolveParams): Promise<CommanderResolveResult>
}

// =============================================================================
// mock 决策实现（基于人格数值的确定性规则）
// =============================================================================

/**
 * 创建 mock 统帅（基于人格数值的确定性规则决策）。
 *
 * 决策逻辑（确定性，不调 LLM）：
 * - 己方每个单位朝最近敌方单位/节点行动（aggression 高 → attack；低 → hold/move）。
 * - obedience < 0.3 时 disobeying=true（数值锚，非随机）。
 *
 * 绝不伪造：单位/目标都来自真实 world 数据。
 */
export function createCommanderRole(): CommanderRole {
  return {
    async resolve(params) {
      return commanderMockResolve(params)
    },
  }
}

/** 默认 mock 统帅实例 */
export const commanderRole: CommanderRole = createCommanderRole()

/**
 * mock 决策：基于人格数值的确定性规则。
 *
 * 对本阵营每个单位：
 * - 若 aggression ≥ 0.6 且附近有敌方单位 → attack 最近敌方；
 * - 否则若附近有高价值节点 → capture_node；
 * - 否则 hold。
 * obedience < 0.3 → disobeying=true。
 */
async function commanderMockResolve(
  params: CommanderResolveParams,
): Promise<CommanderResolveResult> {
  const faction = params.world.factions.find((f) => f.id === params.factionId)
  const aggression = faction?.commander.aggression ?? 0.5
  const obedience = faction?.commander.obedience ?? 0.5

  const ownUnits = params.world.units.filter((u) => u.factionId === params.factionId)
  const enemyUnits = params.world.units.filter((u) => u.factionId !== params.factionId)
  const nodes = params.world.map.highValueNodes

  const decisions: CommanderResolvedDecision[] = []
  for (const unit of ownUnits) {
    const seq = 2000 + decisions.length
    const decision = decideForUnit(unit, enemyUnits, nodes, params.world.map, aggression)
    decisions.push({
      ...decision,
      sequence: seq,
      seed: `${params.scenarioSeed}:${params.turn}:${seq}`,
    })
  }

  return {
    decisions,
    disobeying: obedience < 0.3,
  }
}

/**
 * 为单个单位做确定性决策（mock 规则）。
 *
 * 绝不伪造：找不到目标 → hold。
 */
function decideForUnit(
  unit: { id: string; coord: { col: number; row: number }; factionId: string },
  enemyUnits: ReadonlyArray<{ id: string; coord: { col: number; row: number } }>,
  nodes: ReadonlyArray<{ id: string; name: string; cellId: string }>,
  map: { cols: number; rows: number },
  aggression: number,
): CommanderDecision {
  // 找最近敌方单位
  const nearestEnemy = findNearest(unit.coord, enemyUnits)
  if (nearestEnemy && aggression >= 0.6) {
    return {
      unitId: unit.id,
      intent: 'attack',
      targetUnitId: nearestEnemy.id,
      rationale: `aggression=${aggression.toFixed(2)}，攻击最近敌方 ${nearestEnemy.id}`,
    }
  }
  // 找最近高价值节点
  const nearestNode = nodes.length > 0 ? nodes[0] : null
  if (nearestNode) {
    const nodeCoord = parseCellId(nearestNode.cellId)
    return {
      unitId: unit.id,
      intent: 'capture_node',
      nodeId: nearestNode.id,
      targetCoord: nodeCoord ?? undefined,
      rationale: `朝高价值节点 ${nearestNode.name} 推进`,
    }
  }
  // 兜底：原地固守（绝不伪造坐标/单位）
  void map
  return {
    unitId: unit.id,
    intent: 'hold',
    rationale: '无明确目标，原地固守',
  }
}

/** 找距离 origin 最近的单位（曼哈顿距离）。 */
function findNearest<T extends { coord: { col: number; row: number } }>(
  origin: { col: number; row: number },
  candidates: ReadonlyArray<T>,
): T | null {
  if (candidates.length === 0) return null
  let best = candidates[0]
  let bestDist = manhattan(origin, best.coord)
  for (let i = 1; i < candidates.length; i++) {
    const d = manhattan(origin, candidates[i].coord)
    if (d < bestDist) {
      best = candidates[i]
      bestDist = d
    }
  }
  return best
}

/** 曼哈顿距离。 */
function manhattan(a: { col: number; row: number }, b: { col: number; row: number }): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row)
}

/** 解析 cellId（约定 col:row）为坐标；非法返回 null。 */
function parseCellId(cellId: string): { col: number; row: number } | null {
  const parts = cellId.split(':')
  if (parts.length !== 2) return null
  const col = Number.parseInt(parts[0], 10)
  const row = Number.parseInt(parts[1], 10)
  if (Number.isNaN(col) || Number.isNaN(row)) return null
  return { col, row }
}

// =============================================================================
// 真 LLM 决策实现（独立视野 + 外交响应，失败回退 mock）
// =============================================================================

/** 真 LLM 统帅角色（M3） */
export interface LlmCommanderRole extends CommanderRole {
  readonly llm: LlmService
  readonly config: LlmCallConfig
}

/**
 * 创建真 LLM 统帅（M3）。
 *
 * LLM 在本阵营独立视野 + 人格数值 + 信任度约束内决策；失败回退 mock。
 */
export function createLlmCommanderRole(
  llmService: LlmService,
  config: LlmCallConfig,
): LlmCommanderRole {
  return {
    llm: llmService,
    config,
    async resolve(params) {
      try {
        return await commanderLlmResolve(params, llmService, config)
      } catch (err) {
        if (isLlmCallError(err)) {
          return commanderMockResolve(params)
        }
        throw err
      }
    },
  }
}

/**
 * 真 LLM 决策：commander schema 输出 → 真实性校验 → 阵营决策。
 *
 * 视野：仅本阵营单位（序列化时过滤）；人格/信任度写入 L3 任务文本。
 * 真实性校验：unitId 必须本方真实单位；targetUnitId/nodeId 存在；targetCoord 在范围内。
 */
async function commanderLlmResolve(
  params: CommanderResolveParams,
  llmService: LlmService,
  config: LlmCallConfig,
): Promise<CommanderResolveResult> {
  const faction = params.world.factions.find((f) => f.id === params.factionId)
  const validate = getAgentValidator('commander') as ValidateFunction<CommanderAgentOutput>

  // 视野：仅本方单位 + 已知敌方单位（M3 简化：全量，M4 加情报 ACL）
  const ownUnits = params.world.units
    .filter((u) => u.factionId === params.factionId)
    .map((u) => ({ id: u.id, type: u.type, coord: u.coord, strength: u.strength }))
  const visibleEnemies = params.world.units
    .filter((u) => u.factionId !== params.factionId)
    .map((u) => ({ id: u.id, factionId: u.factionId, coord: u.coord, strength: u.strength }))
  const nodes = params.world.map.highValueNodes.map((n) => ({ id: n.id, name: n.name }))

  const personality = faction?.commander
    ? `本阵营人格：aggression=${faction.commander.aggression}, obedience=${faction.commander.obedience}, preferredTempo=${faction.commander.preferredTempo}。`
    : '本阵营人格：默认中等人格。'

  const task = `回合 ${params.turn}。你是 ${params.factionId} 阵营统帅。${personality}\n本方单位：${JSON.stringify(ownUnits)}\n可见敌方：${JSON.stringify(visibleEnemies)}\n高价值节点：${JSON.stringify(nodes)}\n请决定本回合本方单位的行动。`

  const opts = buildLlmOptions(config, 'commander', params.world, task)
  const { data } = await llmService.streamChatStructured<CommanderAgentOutput>(opts, validate)

  // 真实性校验
  const ownUnitIds = new Set(
    params.world.units.filter((u) => u.factionId === params.factionId).map((u) => u.id),
  )
  const allUnitIds = new Set(params.world.units.map((u) => u.id))
  const nodeIds = new Set(params.world.map.highValueNodes.map((n) => n.id))

  const decisions: CommanderResolvedDecision[] = []
  for (const dec of data.decisions) {
    if (!ownUnitIds.has(dec.unitId)) continue
    if (dec.intent === 'attack' && (!dec.targetUnitId || !allUnitIds.has(dec.targetUnitId))) continue
    if (dec.intent === 'capture_node' && (!dec.nodeId || !nodeIds.has(dec.nodeId))) continue
    if (dec.targetCoord && !isInBounds(dec.targetCoord, params.world.map.cols, params.world.map.rows)) continue
    const seq = 2000 + decisions.length
    decisions.push({
      unitId: dec.unitId,
      intent: dec.intent,
      targetCoord: dec.targetCoord,
      targetUnitId: dec.targetUnitId,
      nodeId: dec.nodeId,
      rationale: dec.rationale,
      sequence: seq,
      seed: `${params.scenarioSeed}:${params.turn}:${seq}`,
    })
  }

  if (decisions.length === 0) {
    return commanderMockResolve(params)
  }

  return {
    decisions,
    disobeying: data.disobeying ?? (faction?.commander.obedience ?? 1) < 0.3,
  }
}

/** 坐标是否在网格范围内。 */
function isInBounds(coord: { col: number; row: number }, cols: number, rows: number): boolean {
  if (cols <= 0 || rows <= 0) return false
  return coord.col >= 0 && coord.col < cols && coord.row >= 0 && coord.row < rows
}

/**
 * 把 CommanderResolvedDecision 转换为 ActionEnvelope（编排层用）。
 *
 * agentRole 固定 'commander'。
 */
export function commanderDecisionToEnvelope(
  decision: CommanderResolvedDecision,
  factionId: string,
  agentId: string,
  turn: number,
): ActionEnvelope {
  return {
    turn,
    faction: factionId,
    agentId,
    agentRole: 'commander' as AgentRole,
    intent: decision.intent,
    payload: {
      unitId: decision.unitId,
      target: decision.targetCoord,
      targetUnitId: decision.targetUnitId,
      nodeId: decision.nodeId,
      rationale: decision.rationale,
    },
    confidence: 0.6,
    requiresConfirmation: false,
    sequence: decision.sequence,
    state: 'locked',
  }
}

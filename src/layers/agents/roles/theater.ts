/**
 * 战区司令角色（theater.ts）— 把宏观指令拆解为单位级动作（mock + 真 LLM 双实现）。
 *
 * 战区司令负责各战区的独立决策（sequence 1000+ 段）。
 * 战区司令之间真并行（sequence 预分配下安全）。
 *
 * 两种实现：
 * - **mock 拆解**（createTheaterRole）：把已确认的候选命令直译为单位级动作
 *   （每条候选 → 每个执行单位一条 action），不调 LLM。离线/测试/兜底用。
 * - **真 LLM 拆解**（createLlmTheaterRole）：经 llm-service 调 streamChatStructured
 *   （theater schema），人格数值（aggression/obedience）约束输出；失败回退 mock。
 *
 * 人格数值基底（修订点 C）：LLM 在 commander.aggression/obedience 约束内发挥；
 * obedience 低时 director 终裁判抗命。此处把人格写入 L3 任务文本（人格属每局不变
 * 的 L1 战役数据已在 context-builder 序列化，此处仅作任务侧提示）。
 *
 * 确定性：sequence 由编排层预分配注入（与完成顺序无关）。
 *
 * @module layers/agents/roles/theater
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
  type TheaterAgentOutput,
  type TheaterUnitAction,
} from '@/layers/agents/protocol/schema'
import { isLlmCallError } from './role-errors'

/**
 * 战区司令拆解输入：已确认的玩家/己方候选命令（来自 chief 解析 + 玩家锁定）。
 *
 * 每个 candidate 对应 chief 的一条 ParsedCommand（intent/unitIds/target 等）。
 */
export interface TheaterTaskCandidate {
  /** 候选命令序号（对应 theater schema 的 sourceCandidateIndex） */
  index: number
  /** 命令意图 */
  intent: string
  /** 执行单位 id 列表（真实单位） */
  unitIds: string[]
  /** 目标坐标（move/capture 可选） */
  targetCoord?: { col: number; row: number }
  /** 被攻击单位 id（attack） */
  targetUnitId?: string
  /** 高价值节点 id（capture_node） */
  nodeId?: string
  /** 自然语言说明（chief 的 summary） */
  summary?: string
}

/** 战区司令拆解入参 */
export interface TheaterResolveParams {
  /** 当前世界状态（L1+L2 来源） */
  world: WorldState
  /** 己方阵营 id（仅匹配本方单位） */
  factionId: string
  /** 待拆解的候选命令 */
  candidates: TheaterTaskCandidate[]
  /** 当前回合 */
  turn: number
  /** 场景种子（构造 seed 留痕用） */
  scenarioSeed: string
  /**
   * 流式 partial 回调（第 2 批，可选）：LLM 每产出一段文本片段时回调，
   * 编排层据此把 partial 写入 store agentLiveOutputs，AgentInspector 显示实时输出。
   * 仅 UI 副作用，**不影响 prompt 结构/缓存前缀/确定性产物**。
   * mock 实现一次性全量回调（模拟"瞬时完成"）。
   */
  onDelta?: (partial: string) => void
}

/** 战区司令拆解产物：单位级动作信封（sequence 已由编排层预分配，此处写入） */
export interface TheaterResolveResult {
  /** 拆解出的单位级动作（每条带预分配 sequence） */
  actions: TheaterResolvedAction[]
}

/** 单条单位级动作（带预分配 sequence，供编排层构造 ActionEnvelope） */
export interface TheaterResolvedAction extends TheaterUnitAction {
  /** 预分配的 sequence（编排层注入） */
  sequence: number
  /** 确定性 seed（scenarioSeed:turn:sequence） */
  seed: string
}

/** 战区司令角色接口（mock + LLM 共用签名） */
export interface TheaterRole {
  /**
   * 把候选命令拆解为单位级动作。
   *
   * @param params 见 TheaterResolveParams
   * @returns 单位级动作列表（带预分配 sequence）
   */
  resolve(params: TheaterResolveParams): Promise<TheaterResolveResult>
}

// =============================================================================
// mock 拆解实现（直译，不调 LLM）
// =============================================================================

/**
 * 创建 mock 战区司令（直译拆解，不调 LLM）。
 *
 * 每条候选命令 → 每个执行单位一条 action（intent/unitId/target 透传）。
 * 不伪造：unitId 仅引用 candidate.unitIds 中的真实单位。
 */
export function createTheaterRole(): TheaterRole {
  return {
    async resolve(params) {
      return theaterMockResolve(params)
    },
  }
}

/** 默认 mock 战区司令实例 */
export const theaterRole: TheaterRole = createTheaterRole()

/**
 * mock 拆解：候选 → 单位级动作（直译）。
 *
 * sequence 由编排层在调用方注入（allocateSequences 给每条 action 预分配）；
 * 此处仅把 candidate 字段透传为 TheaterUnitAction，序列号留 0 占位（编排层覆盖）。
 */
async function theaterMockResolve(
  params: TheaterResolveParams,
): Promise<TheaterResolveResult> {
  const actions: TheaterResolvedAction[] = []
  // 占位 sequence（0）；编排层会用 allocateOne/theater 段位覆盖。
  // 注意：mock 路径下编排层负责预分配并覆盖 sequence/seed，此处仅产语义。
  const placeholderSeq = 1000
  for (const cand of params.candidates) {
    for (let i = 0; i < cand.unitIds.length; i++) {
      const unitId = cand.unitIds[i]
      const seq = placeholderSeq + actions.length
      actions.push({
        sourceCandidateIndex: cand.index,
        unitId,
        intent: cand.intent as TheaterUnitAction['intent'],
        targetCoord: cand.targetCoord,
        targetUnitId: cand.targetUnitId,
        nodeId: cand.nodeId,
        sequence: seq,
        seed: `${params.scenarioSeed}:${params.turn}:${seq}`,
      })
    }
  }
  // 第 2 批：mock 模拟"瞬时完成"，一次性全量回调产出的动作摘要（让 AgentInspector
  // 在 mock 路径下也有实时 partial 显示，统一 UI 逻辑路径）。
  if (params.onDelta && actions.length > 0) {
    const summary = actions
      .map((a) => `${a.intent}:${a.unitId}`)
      .join(', ')
    params.onDelta(`[mock 拆解] ${summary}`)
  }
  return { actions }
}

// =============================================================================
// 真 LLM 拆解实现（人格数值约束，失败回退 mock）
// =============================================================================

/** 真 LLM 战区司令角色（M3） */
export interface LlmTheaterRole extends TheaterRole {
  readonly llm: LlmService
  readonly config: LlmCallConfig
}

/**
 * 创建真 LLM 战区司令（M3）。
 *
 * LLM 在 commander 人格（aggression/obedience）约束内拆解；失败回退 mock。
 */
export function createLlmTheaterRole(
  llmService: LlmService,
  config: LlmCallConfig,
): LlmTheaterRole {
  return {
    llm: llmService,
    config,
    async resolve(params) {
      try {
        return await theaterLlmResolve(params, llmService, config)
      } catch (err) {
        if (isLlmCallError(err)) {
          return theaterMockResolve(params)
        }
        throw err
      }
    },
  }
}

/**
 * 真 LLM 拆解：候选 → theater schema 输出 → 真实性校验 → 单位级动作。
 *
 * 人格数值约束：把 faction.commander 的 aggression/obedience/preferredTempo
 * 写入 L3 任务文本，LLM 在数值锚内发挥。
 *
 * 真实性校验：unitId 必须是己方真实单位；targetCoord 在范围内；targetUnitId/nodeId 存在。
 * 校验不过的 action 剔除；全部剔除则回退 mock（编排层调 mock 产语义）。
 */
async function theaterLlmResolve(
  params: TheaterResolveParams,
  llmService: LlmService,
  config: LlmCallConfig,
): Promise<TheaterResolveResult> {
  if (params.candidates.length === 0) {
    return { actions: [] }
  }

  const faction = params.world.factions.find((f) => f.id === params.factionId)
  const validate = getAgentValidator('theater') as ValidateFunction<TheaterAgentOutput>

  // L3 任务文本（候选列表 + 人格数值锚 + 回合号属 L3 安全）
  const candidateJson = JSON.stringify(params.candidates.map((c) => ({
    index: c.index,
    intent: c.intent,
    unitIds: c.unitIds,
    targetCoord: c.targetCoord,
    targetUnitId: c.targetUnitId,
    nodeId: c.nodeId,
    summary: c.summary,
  })))
  const personality = faction?.commander
    ? `人格约束：aggression=${faction.commander.aggression}, obedience=${faction.commander.obedience}, preferredTempo=${faction.commander.preferredTempo}。`
    : '人格约束：使用默认中等人格。'
  const task = `回合 ${params.turn}。请把以下候选命令拆解为单位级可执行动作（每个单位一条 action）。\n${personality}\n候选命令：\n${candidateJson}`

  const opts = buildLlmOptions(config, 'theater', params.world, task)
  const { data } = await llmService.streamChatStructured<TheaterAgentOutput>(
    opts,
    validate,
    // 第 2 批：onDelta 透传 partial 给编排层（store agentLiveOutputs → AgentInspector）。
    params.onDelta,
  )

  // 真实性校验
  const ownUnitIds = new Set(
    params.world.units.filter((u) => u.factionId === params.factionId).map((u) => u.id),
  )
  const allUnitIds = new Set(params.world.units.map((u) => u.id))
  const nodeIds = new Set(params.world.map.highValueNodes.map((n) => n.id))

  const actions: TheaterResolvedAction[] = []
  for (const act of data.actions) {
    if (!ownUnitIds.has(act.unitId)) continue
    if (act.intent === 'attack' && (!act.targetUnitId || !allUnitIds.has(act.targetUnitId))) continue
    if (act.intent === 'capture_node' && (!act.nodeId || !nodeIds.has(act.nodeId))) continue
    if (act.targetCoord && !isInBounds(act.targetCoord, params.world.map.cols, params.world.map.rows)) continue
    // 占位 sequence（编排层覆盖）；此处仅产语义
    const seq = 1000 + actions.length
    actions.push({
      sourceCandidateIndex: act.sourceCandidateIndex,
      unitId: act.unitId,
      intent: act.intent,
      targetCoord: act.targetCoord,
      targetUnitId: act.targetUnitId,
      nodeId: act.nodeId,
      sequence: seq,
      seed: `${params.scenarioSeed}:${params.turn}:${seq}`,
    })
  }

  if (actions.length === 0) {
    // 全部校验失败：回退 mock 语义（编排层覆盖 sequence）
    return theaterMockResolve(params)
  }
  return { actions }
}

/** 坐标是否在网格范围内（与 chief mock 同语义）。 */
function isInBounds(coord: { col: number; row: number }, cols: number, rows: number): boolean {
  if (cols <= 0 || rows <= 0) return false
  return coord.col >= 0 && coord.col < cols && coord.row >= 0 && coord.row < rows
}

/**
 * 把 TheaterResolvedAction 转换为 ActionEnvelope（编排层用）。
 *
 * agentRole 固定 'theater'，agentId 由调用方指定（如 "theater-blue-1"）。
 */
export function theaterActionToEnvelope(
  action: TheaterResolvedAction,
  factionId: string,
  agentId: string,
  turn: number,
): ActionEnvelope {
  return {
    turn,
    faction: factionId,
    agentId,
    agentRole: 'theater' as AgentRole,
    intent: action.intent,
    payload: {
      unitId: action.unitId,
      target: action.targetCoord,
      targetUnitId: action.targetUnitId,
      nodeId: action.nodeId,
    },
    confidence: 0.7,
    requiresConfirmation: false,
    sequence: action.sequence,
    state: 'locked',
  }
}

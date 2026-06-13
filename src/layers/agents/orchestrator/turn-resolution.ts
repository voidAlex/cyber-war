/**
 * 多 Agent 确定性编排（orchestrator/turn-resolution.ts）。
 *
 * 对应 TDD §3.4「Agent 编排流程与延迟优化」与重写计划「确定性 sequence 预分配」
 * 「导演部终裁」「规则引擎兜底」「防坑-并发抢序/伪造/padding」。
 *
 * 编排流程（确定性 sequence 预分配 + 真并行 + 导演部终裁）：
 * 1. **物理引擎先算 rawResults**（workerService.simulateTurn，确定性）。
 * 2. **批次1 参谋长**（玩家侧，串行）：解析/确认玩家指令 → envelopes（chief 段 0+）。
 *    实际 lockedOrders 已在握手阶段冻结；此处收集为 chief envelopes。
 * 3. **批次2 战区司令**（玩家侧各战区，并行，sequence 1000+ 预分配）：
 *    把玩家宏观指令拆解为单位级 AgentAction → envelopes。
 * 4. **批次3 敌/盟统帅**（非玩家阵营，与批次2 并行，sequence 2000+ 预分配）：
 *    阵营决策 → envelopes。
 * 5. **批次4 导演部**（最后，串行，sequence 3000+）：
 *    adjudicate(rawResults, envelopes) → finalResult + 流式战报 + 覆写留痕。
 *
 * **确定性根**：sequence 在派发时一次性预分配（allocateSequences），
 * 与 Agent 完成顺序无关。战区/敌盟用 Promise.all 真并行，sequence 稳定。
 *
 * **降级**：任一 Agent LLM 失败/degraded → 该角色内部回退 mock；
 * 导演部 LLM 失败 → 编排层自动切规则引擎兜底（rule-engine-fallback）。
 *
 * **不做 padding/sleep**（审计教训）：11-15s 是真实多步执行耗时。
 *
 * @module layers/agents/orchestrator/turn-resolution
 */

import type {
  ActionEnvelope,
  WorldState,
  AgentAction,
  ResolutionSummary,
} from '@/types'
import type { LlmService, CacheStats } from '@/layers/application/services/llm-service'
import type { PhysicsEngineClient } from '@/layers/application/services/worker-service'
import type { ResolutionResult } from '@/layers/domain/combat'
import type {
  TheaterRole,
  TheaterTaskCandidate,
  CommanderRole,
  DirectorRole,
  LlmCallConfig,
} from '@/layers/agents/roles'
import { theaterActionToEnvelope, commanderDecisionToEnvelope } from '@/layers/agents/roles'
import { allocateSequences, SEQUENCE_BASE, makeSeed } from './sequence-allocator'
import { ruleEngineFallback, type RuleEngineFallbackResult } from '@/layers/agents/director/rule-engine-fallback'

// =============================================================================
// 编排产物类型
// =============================================================================

/** 编排入参（依赖注入，便于 mock 测试） */
export interface OrchestrateTurnResolutionParams {
  /** 当前世界状态（只读） */
  worldState: WorldState
  /** 已锁定的命令（按 factionId 分组；玩家侧来自握手锁定） */
  lockedOrders: Record<string, ActionEnvelope[]>
  /** 场景固定种子 */
  scenarioSeed: string
  /** 结算回合 */
  turn: number
  /** LLM 服务（真流式 + schema 校验 + 缓存统计） */
  llmService: LlmService
  /** 物理引擎客户端（确定性结算，需已 init） */
  workerService: PhysicsEngineClient
  /** 战区司令角色（mock 或 LLM） */
  theaterRole: TheaterRole
  /** 敌/盟统帅角色（mock 或 LLM） */
  commanderRole: CommanderRole
  /** 导演部角色（mock 或 LLM） */
  directorRole: DirectorRole
  /**
   * 玩家阵营 id（用于区分玩家侧战区 vs 敌盟统帅）。
   * 默认取 worldState.factions 中 side==='player' 的首个。
   */
  playerFactionId?: string
  /** LLM 调用配置（若 theater/commander/director 为 LLM 角色需注入；mock 角色可省略） */
  llmConfig?: LlmCallConfig
  /**
   * 进度回调（可选，纯 UI 可观测副作用，**不影响编排产物与确定性**）。
   *
   * 编排在各批次完成时回调 onProgress 通知 UI 更新 agentProgressById。
   * 不传时无副作用（默认值），已有测试不受影响。
   *
   * 注意：onProgress 仅用于进度展示，绝不参与 envelopes/events/sequence 计算
   * （确定性由 scenarioSeed:turn:sequence 预分配保证，与本回调无关）。
   */
  onProgress?: (entry: TurnResolutionProgress) => void
  /**
   * 流式战报回调（可选）：导演部战报文本增量流出时回调（TTFT<200ms 目标）。
   * 不传时导演部按非流式产出完整战报（默认行为，测试不受影响）。
   */
  onReportChunk?: (chunk: string) => void
}

/**
 * 编排进度条目（onProgress 回调入参，纯 UI 可观测）。
 *
 * 不含任何影响确定性的字段（仅 status/agentId/role/partial）。
 */
export interface TurnResolutionProgress {
  /** Agent id（chief-{faction} / theater-{faction} / commander-{faction} / director） */
  agentId: string
  /** 角色 */
  role: 'chief' | 'theater' | 'commander' | 'director'
  /** 当前状态 */
  status: 'thinking' | 'running' | 'adjudicating' | 'done' | 'failed'
  /** 当前输出的部分文本（可选） */
  partial?: string
  /** 错误信息（失败时） */
  error?: string
}

/** 编排产物 */
export interface OrchestrateTurnResolutionResult {
  /** 终裁后的结算结果（物理 + 导演部覆写后） */
  result: ResolutionResult
  /** 战报摘要（briefing 展示） */
  resolution: ResolutionSummary
  /** 本回合所有 Agent envelopes（chief/theater/commander 段，按 sequence 升序） */
  envelopes: ActionEnvelope[]
  /** 落 event-log 的事件（physics + director + rule-engine 分源标记） */
  events: AgentAction[]
  /** 导演部覆写留痕（写 directorMemory.overrides） */
  appliedOverrides: import('@/layers/agents/protocol/schema').DirectorOverride[]
  /** 本回合关键叙事事件（写 directorMemory.keyEvents） */
  keyEvents: string[]
  /** 缓存命中统计（累计，供 Inspector） */
  cacheStats: CacheStats
  /** 是否规则引擎降级（导演部 LLM 失败时 true） */
  degraded: boolean
}

/**
 * 编排内部的 envelope 包装（携带 sequence 段信息，便于排序/留痕）。
 * @internal 仅供本模块与测试引用。
 */
export interface OrchestrationEnvelope {
  envelope: ActionEnvelope
  /** 段（chief/theater/commander/director） */
  segment: 'chief' | 'theater' | 'commander' | 'director'
}

// =============================================================================
// 主入口：orchestrateTurnResolution
// =============================================================================

/**
 * 编排一个完整回合的多 Agent 结算（M3 核心）。
 *
 * 流程（对应 TDD §3.4）：
 * 1. 物理引擎先算 rawResults（确定性）。
 * 2. 批次1 参谋长：收集玩家 lockedOrders 为 chief envelopes（seq 0+）。
 * 3. 批次2+3 战区（玩家侧）+ 敌盟统帅（非玩家阵营）**并行**（sequence 预分配）。
 * 4. 批次4 导演部终裁（最后，串行）：adjudicate(rawResults, allEnvelopes)。
 * 5. 导演部 LLM 失败 → 自动切规则引擎兜底。
 *
 * **确定性**：相同 (worldState, lockedOrders, scenarioSeed, turn) →
 * 相同 envelopes 顺序（sequence 预分配，与调度/完成顺序无关）。
 * LLM 输出本身非确定，但回放从 event-log 读不重算。
 *
 * @param params 见 OrchestrateTurnResolutionParams
 * @returns 编排产物（result + envelopes + events + cacheStats）
 */
export async function orchestrateTurnResolution(
  params: OrchestrateTurnResolutionParams,
): Promise<OrchestrateTurnResolutionResult> {
  const {
    worldState,
    lockedOrders,
    scenarioSeed,
    turn,
    llmService,
    workerService,
    theaterRole,
    commanderRole,
    directorRole,
    onProgress,
  } = params

  const playerFactionId = params.playerFactionId ?? resolvePlayerFactionId(worldState)
  // 所有 envelope（最终按 sequence 升序输出）
  const allEnvelopes: ActionEnvelope[] = []

  // -------------------------------------------------------------------------
  // 步骤1：物理引擎先算 rawResults（确定性）
  // -------------------------------------------------------------------------
  const playerLocked = (lockedOrders[playerFactionId] ?? []).slice().sort(
    (a, b) => a.sequence - b.sequence,
  )
  const rawResults: ResolutionResult = await workerService.simulateTurn(
    worldState,
    playerLocked,
    scenarioSeed,
  )

  // -------------------------------------------------------------------------
  // 步骤2：批次1 参谋长（玩家侧）— chief envelopes（seq 0+，已在握手阶段预分配）
  // -------------------------------------------------------------------------
  // lockedOrders 中玩家侧信封即 chief 批次产物（sequence 已在握手阶段分配）。
  const chiefEnvelopes = playerLocked.map((e) => ({
    ...e,
    agentRole: 'chief' as const,
    state: 'executing' as const,
  }))
  allEnvelopes.push(...chiefEnvelopes)

  // 把 chief envelopes 转换为战区拆解输入（TheaterTaskCandidate）
  const theaterCandidates: TheaterTaskCandidate[] = chiefEnvelopes.map((e, index) => ({
    index,
    intent: String(e.payload['intent'] ?? e.intent),
    unitIds: extractUnitIds(e),
    targetCoord: extractCoord(e),
    targetUnitId: extractTargetUnitId(e),
    nodeId: extractNodeId(e),
    summary: String(e.payload['summary'] ?? e.intent),
  }))

  // -------------------------------------------------------------------------
  // 步骤3：批次2 战区（玩家侧）+ 批次3 敌盟统帅（非玩家阵营）并行
  // -------------------------------------------------------------------------
  // sequence 预分配（派发时一次性分配，与完成顺序无关）
  const theaterAlloc = allocateSequences(
    'theater',
    theaterCandidates.length,
    scenarioSeed,
    turn,
  )
  const nonPlayerFactions = worldState.factions.filter((f) => f.id !== playerFactionId)
  const commanderAlloc = allocateSequences(
    'commander',
    nonPlayerFactions.length,
    scenarioSeed,
    turn,
  )

  // 并行执行战区 + 所有敌盟统帅（sequence 已预分配，安全）
  // 进度：chief 批次已完成（lockedOrders 收集完毕）
  if (onProgress) {
    for (const e of chiefEnvelopes) {
      onProgress({ agentId: e.agentId, role: 'chief', status: 'done' })
    }
    // 战区司令 + 各敌盟统帅标记为 running（并行开始）
    onProgress({ agentId: `theater-${playerFactionId}`, role: 'theater', status: 'running' })
    for (const f of nonPlayerFactions) {
      onProgress({ agentId: `commander-${f.id}`, role: 'commander', status: 'running' })
    }
  }

  const theaterTask = theaterRole
    .resolve({
      world: worldState,
      factionId: playerFactionId,
      candidates: theaterCandidates,
      turn,
      scenarioSeed,
    })
    .then((res) => {
      // 用预分配 sequence 覆盖 mock/LM 产出的占位 sequence
      const envelopes = res.actions.map((act, i) => {
        const sequence = theaterAlloc.sequences[i] ?? act.sequence
        const seed = makeSeed(scenarioSeed, turn, sequence)
        return theaterActionToEnvelope(
          { ...act, sequence, seed },
          playerFactionId,
          `theater-${playerFactionId}-${i}`,
          turn,
        )
      })
      if (onProgress) {
        onProgress({ agentId: `theater-${playerFactionId}`, role: 'theater', status: 'done' })
      }
      return { segment: 'theater' as const, envelopes }
    })

  const commanderTasks = nonPlayerFactions.map((f, i) =>
    commanderRole
      .resolve({
        world: worldState,
        factionId: f.id,
        turn,
        scenarioSeed,
      })
      .then((res) => {
        const sequenceBase = commanderAlloc.sequences[i] ?? SEQUENCE_BASE.commander
        const envelopes = res.decisions.map((dec, j) => {
          const sequence = sequenceBase + j
          const seed = makeSeed(scenarioSeed, turn, sequence)
          return commanderDecisionToEnvelope(
            { ...dec, sequence, seed },
            f.id,
            `commander-${f.id}`,
            turn,
          )
        })
        if (onProgress) {
          onProgress({ agentId: `commander-${f.id}`, role: 'commander', status: 'done' })
        }
        return { segment: 'commander' as const, envelopes }
      }),
  )

  // 真并行（Promise.all）；sequence 预分配保证回放一致
  const [theaterOut, ...commanderOuts] = await Promise.all([theaterTask, ...commanderTasks])

  // 收集 theater + commander envelopes（按预分配 sequence 排序）
  allEnvelopes.push(...theaterOut.envelopes)
  for (const out of commanderOuts) {
    allEnvelopes.push(...out.envelopes)
  }

  // 全部 envelope 按 sequence 升序（确定性输出顺序）
  allEnvelopes.sort((a, b) => a.sequence - b.sequence)

  // -------------------------------------------------------------------------
  // 步骤4：批次4 导演部终裁（最后，串行）
  // -------------------------------------------------------------------------
  let directorResult:
    | Awaited<ReturnType<DirectorRole['adjudicate']>>
    | RuleEngineFallbackResult
  let degraded = false
  // 进度：导演部裁定开始
  if (onProgress) {
    onProgress({ agentId: 'director', role: 'director', status: 'adjudicating' })
  }
  try {
    directorResult = await directorRole.adjudicate({
      physicsResult: rawResults,
      envelopes: allEnvelopes,
      world: worldState,
      scenarioSeed,
      turn,
      onReportChunk: params.onReportChunk,
    })
    if (onProgress) {
      onProgress({ agentId: 'director', role: 'director', status: 'done' })
    }
  } catch (err) {
    // 导演部异常（非 LLM 类）：切规则引擎兜底（绝不卡死游戏）
    if (onProgress) {
      onProgress({
        agentId: 'director',
        role: 'director',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
    degraded = true
    directorResult = ruleEngineFallback({
      physicsResult: rawResults,
      envelopes: allEnvelopes,
      world: worldState,
      scenarioSeed,
      turn,
      degradeReason: `导演部异常：${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // 判断是否走规则引擎兜底：RuleEngineFallbackResult 无 appliedOverrides/keyEvents。
  if (!isDirectorRealResult(directorResult)) degraded = true

  // 兜底产物无 appliedOverrides/keyEvents（director 真路径才有）。
  // 内联守卫以收窄类型。
  const appliedOverrides = isDirectorRealResult(directorResult)
    ? (directorResult.appliedOverrides ?? [])
    : []
  const keyEvents = isDirectorRealResult(directorResult)
    ? (directorResult.keyEvents ?? [])
    : []

  return {
    result: directorResult.finalResult,
    resolution: directorResult.resolutionSummary,
    envelopes: allEnvelopes,
    events: directorResult.directorEvents,
    appliedOverrides,
    keyEvents,
    cacheStats: llmService.getCacheStats(),
    degraded,
  }
}

// =============================================================================
// 辅助：从 ActionEnvelope.payload 提取字段（与 worker extractPayloadField 同语义）
// =============================================================================

/** 从 envelope.payload 提取执行单位 id 列表（chief 锁定的指令含 unitIds）。 */
function extractUnitIds(envelope: ActionEnvelope): string[] {
  const raw = envelope.payload['unitIds']
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  // 单 unitId 字段兜底
  const single = envelope.payload['unitId']
  if (typeof single === 'string' && single.length > 0) return [single]
  return []
}

/** 从 envelope.payload 提取目标坐标（{col,row} 或 "col,row"）。 */
function extractCoord(envelope: ActionEnvelope): { col: number; row: number } | undefined {
  const raw = envelope.payload['target'] ?? envelope.payload['targetCoord']
  if (!raw) return undefined
  if (typeof raw === 'object' && raw !== null && 'col' in raw && 'row' in raw) {
    const c = raw as { col: unknown; row: unknown }
    if (typeof c.col === 'number' && typeof c.row === 'number') {
      return { col: c.col, row: c.row }
    }
  }
  return undefined
}

/** 从 envelope.payload 提取 targetUnitId。 */
function extractTargetUnitId(envelope: ActionEnvelope): string | undefined {
  const raw = envelope.payload['targetUnitId']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** 从 envelope.payload 提取 nodeId。 */
function extractNodeId(envelope: ActionEnvelope): string | undefined {
  const raw = envelope.payload['nodeId']
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

/** 取玩家阵营 id（side==='player' 的首个；无则取首个阵营）。 */
function resolvePlayerFactionId(world: WorldState): string {
  const player = world.factions.find((f) => f.side === 'player')
  return player?.id ?? world.factions[0]?.id ?? ''
}

/** director 真路径产物类型（含 appliedOverrides/keyEvents） */
type DirectorRealResult = Awaited<ReturnType<DirectorRole['adjudicate']>>

/**
 * 运行时判断 directorResult 是否为导演部真路径产物（含 appliedOverrides/keyEvents）。
 *
 * RuleEngineFallbackResult 与 DirectorAdjudicateResult 结构兼容（都有 finalResult/
 * resolutionSummary/directorEvents），但兜底产物无 appliedOverrides/keyEvents。
 * 用 'appliedOverrides' in 判定收窄类型。
 */
function isDirectorRealResult(
  result: DirectorRealResult | RuleEngineFallbackResult,
): result is DirectorRealResult {
  return 'appliedOverrides' in result
}

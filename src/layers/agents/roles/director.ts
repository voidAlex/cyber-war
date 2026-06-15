/**
 * 导演部角色（director.ts）— M2 mock 终裁。
 *
 * 导演部负责：终裁（可覆写数值但必须留痕）+ 战报润色 + 兜底。
 * M3 使用 deepseek-v4-pro（强推理）用于关键终裁。
 *
 * M2 实现：直接采用物理引擎结果（directorResult = physicsResult），
 * 不调 LLM。仅做战报文本拼装（从 ResolutionResult.events 汇总）。
 *
 * 为 M3 预留 `adjudicate(physicsResult, envelopes)→finalResult` 接口：
 * - M3 时在此处接入 LLM 终裁（可覆写数值，留痕到 directorMemory.overrides）。
 * - M2 时此接口直接透传物理结果（不覆写）。
 *
 * 确定性两层（重写计划）：
 * - 物理层：physics 事件标 source:'physics'，可重算校验。
 * - 导演层：M3 的覆写标 source:'director'（记录即真相，回放不重算）。
 *
 * @module layers/agents/roles/director
 */

import type {
  ActionEnvelope,
  AgentAction,
  ResolutionSummary,
  WorldState,
  RandomEvent,
  TacticalDecision,
  TacticalDecisionTemplate,
} from '@/types'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'
import type { ValidateFunction } from 'ajv'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from './llm-role-base'
import { buildLlmOptions } from './llm-role-base'
import {
  getAgentValidator,
  type DirectorAgentOutput,
  type DirectorOverride,
} from '@/layers/agents/protocol/schema'
import { parseLLMJson } from '@/layers/agents/protocol/schema'
import { LlmJsonParseError } from '@/layers/agents/protocol/schema'
import { isLlmCallError } from './role-errors'
import {
  generateRuleEngineSummary,
  applyContextSummary,
} from './context-compression'

/**
 * 导演部终裁入参（M3 接 LLM 时在此扩展 prompt 上下文）。
 */
export interface DirectorAdjudicateParams {
  /** 物理引擎结算结果（M2 直接采信；M3 可覆写但留痕） */
  physicsResult: ResolutionResult
  /** 本回合锁定的命令（供终裁参考/抗命判定） */
  envelopes: ActionEnvelope[]
  /** 当前世界状态（只读，用于查询单位/节点） */
  world: WorldState
  /** 场景种子（确定性：scenarioSeed:turn:seq） */
  scenarioSeed: string
  /** 结算回合 */
  turn: number
  /**
   * 流式战报回调（可选）：导演部战报文本增量流出时回调（TTFT<200ms 目标）。
   * 不传时按非流式产出完整战报（默认行为，mock 透传与测试不受影响）。
   */
  onReportChunk?: (chunk: string) => void
  /**
   * 本回合已触发的随机事件（第 2 批，物理结算后、adjudicate 前由 rollRandomEvents 产出）。
   *
   * 每个 RandomEvent.effects 已是确定性的 DirectorOverride[]（field=units.<id>.<field>）。
   * 导演部职责：
   * 1. 在战报叙事中描述事件 + 影响（reportText 体现，keyEvents 标记）。
   * 2. effects 作为已确定的覆写并入 overrides（与 LLM 自身覆写合并，effects 优先）。
   *
   * 不传（空数组）时无随机事件，与既有行为兼容（测试不受影响）。
   */
  randomEvents?: RandomEvent[]
  /**
   * 第 3 批：战役战术决策模板（可选，来自 CampaignRules.decisions）。
   *
   * 导演部按 triggerCondition 判定是否触发本回合的决策：
   * - 'turn_in'：确定性触发（如第 3/10 回合的历史节点）。
   * - 'morale_below'：某阵营平均士气低于阈值时触发（动态态势）。
   *
   * 触发后产出 TacticalDecision（具体选项 + 已解析 overrides），
   * 由编排器 OFFER_DECISION 挂起，等玩家选择。
   *
   * 不传（空数组）时无决策，与既有行为兼容。
   */
  decisionTemplates?: TacticalDecisionTemplate[]
}

/**
 * 导演部终裁结果。
 *
 * M2：finalResult = physicsResult（不覆写）；reportText 由 events 拼装。
 * M3：可覆写 stateChanges（留痕），reportText 由 LLM 润色。
 */
export interface DirectorAdjudicateResult {
  /** 终裁后的最终结算结果（M2=physicsResult 透传；M3 可覆写 stateChanges） */
  finalResult: ResolutionResult
  /** 战报摘要（briefing 阶段展示） */
  resolutionSummary: ResolutionSummary
  /** 导演部产出的事件（M2 仅复制 physics 事件为 AgentAction 入 event-log） */
  directorEvents: AgentAction[]
  /**
   * 已应用的数值覆写留痕（M3 LLM 终裁产出）。
   * 每条含 field/before/after/reason，落 directorMemory.overrides + event-log。
   * M2 mock 为空数组。
   */
  appliedOverrides?: DirectorOverride[]
  /** 本回合关键叙事事件（M3 LLM 产出，落 directorMemory.keyEvents） */
  keyEvents?: string[]
  /**
   * 第 3 批：本回合触发的战术决策（可选）。
   *
   * 导演部按 rules.decisions 模板 + 本回合态势产出。
   * 编排器据此 OFFER_DECISION 挂起，等玩家在 decision 阶段选择。
   * 不触发（无匹配模板）时为 undefined，与既有行为兼容。
   */
  pendingDecision?: TacticalDecision
}

/**
 * 导演部角色实例（M2 mock，M3 可替换为 LLM 实现）。
 */
export interface DirectorRole {
  /**
   * 终裁：对物理引擎结果做最终裁定 + 战报润色。
   *
   * M2：直接采信物理结果，不覆写；战报从 events 拼装。
   * M3：接入 LLM，可覆写 stateChanges（必须留痕到 world.directorMemory.overrides）。
   *
   * @param params 见 DirectorAdjudicateParams
   * @returns 终裁结果 + 战报 + 导演部事件
   */
  adjudicate(params: DirectorAdjudicateParams): Promise<DirectorAdjudicateResult>
}

/** 压缩上下文产物（ContextCompressor.compress 返回） */
export interface ContextCompressionOutput {
  /** 摘要文本（~500 tokens） */
  summary: string
  /** 压缩事件（入 event-log，回放采信） */
  event: AgentAction
  /** 更新后的 contextSummaries（深拷贝 + 追加本轮 summary） */
  contextSummaries: Record<number, string>
}

/**
 * 上下文压缩器（TDD §3.6，每 5 回合 briefing 阶段）。
 *
 * 独立于 DirectorRole（避免在 DirectorRole 上加方法破坏既有 mock）。
 * 编排器在 briefing 阶段当 shouldCompressContext(turn) 时调用。
 *
 * 默认实现 compressContextWithRuleEngine（规则引擎模板，source:'rule-engine'）。
 * 落盘（写 factions/{factionId}/context-summary.md）由编排器经 gateway 完成。
 */
export interface ContextCompressor {
  compress(
    world: WorldState,
    scenarioSeed: string,
    turn: number,
  ): Promise<ContextCompressionOutput>
}

/**
 * 创建 M2 mock 导演部（直接采信物理结果）。
 *
 * M3 时替换为真 LLM 实现（保持 adjudicate 签名不变）。
 */
export function createDirectorRole(): DirectorRole {
  return {
    async adjudicate(params) {
      return adjudicateMock(params)
    },
  }
}

/**
 * 创建默认上下文压缩器（规则引擎模板，source:'rule-engine'）。
 *
 * 编排器在 briefing 阶段当 shouldCompressContext(turn) 时调用。
 * 落盘（写 factions/{factionId}/context-summary.md）由编排器经 gateway 完成。
 */
export function createDefaultContextCompressor(): ContextCompressor {
  return {
    async compress(world, scenarioSeed, turn) {
      return compressContextMock(world, scenarioSeed, turn)
    },
  }
}

/**
 * 默认导演部实例（M2 mock）。
 * 直接 import 此实例即可使用；测试/替换时用 createDirectorRole() 重建。
 */
export const directorRole: DirectorRole = createDirectorRole()

// ============================================================================
// event-log sequence 槽位常量（P1-6 互斥槽位，防同回合重复 event id）
// ============================================================================
//
// director 段位（3000+）末尾的固定槽必须**全局互斥**，否则第 5 回合
// （report + 上下文压缩同触发）会产生重复 event id，破坏 event-log 唯一契约。
//
// 槽位分配（与 context-compression.ts / rule-engine-fallback.ts 对齐）：
//   3000 + i（i=0..996）：director 覆写事件（overridesToDirectorActions，每条占一槽）
//   3997：director 战报事件（reportToDirectorAction）
//   3998：mock 上下文压缩事件（compressContextMock，离线默认压缩器）
//   3999：真 上下文压缩事件（context-compression.ts compressContextWithRuleEngine）
//   4000：规则引擎兜底说明（rule-engine-fallback.ts makeFallbackNotice）
//
// 注意：mock 压缩（3998）与真压缩（3999）槽位不同——但两者互斥使用
// （同一编排只挂载 createDefaultContextCompressor 或 createLlmDirectorRole 之一，
// 不会同时产出 3998 和 3999 事件）。即便同时存在，id 也不冲突。
export const SEQUENCE_DIRECTOR_REPORT = 3997
export const SEQUENCE_DIRECTOR_MOCK_COMPRESS = 3998
/**
 * 第 2 批：随机事件专用 sequence 槽（4001+，与 3997-4000 段位区分）。
 *
 * 多个随机事件按 4001 + index 偏移占用，保证同回合互斥 event id。
 */
export const SEQUENCE_DIRECTOR_RANDOM_EVENT_BASE = 4001
/**
 * 第 3 批：战术决策后果专用 sequence 槽（4010+，与随机事件 4001 段位区分）。
 *
 * 玩家在 decision 阶段选择某选项后，其 overrides 落 event-log。
 * 每个 override 按 4010 + index 偏移占用，保证同回合互斥 event id。
 */
export const SEQUENCE_DIRECTOR_DECISION_OVERRIDE_BASE = 4010

// ============================================================================
// M3 真 LLM 导演部（终裁 + 覆写留痕 + 流式战报；失败回退 mock）
// ============================================================================

/** 真 LLM 导演部角色（M3，用 deepseek-v4-pro 强推理） */
export interface LlmDirectorRole extends DirectorRole {
  readonly llm: LlmService
  readonly config: LlmCallConfig
}

/**
 * 创建真 LLM 导演部（M3）。
 *
 * 终裁流程（adjudicate 内部）：
 * 1. 调 LLM（director schema + context-builder L0-L3）→ reportText + overrides + keyEvents。
 * 2. 应用 overrides 到 finalResult.stateChanges（**覆写留痕**：写 directorMemory.overrides）。
 * 3. 产出 source:'director' 事件（覆写 + 战报）入 event-log；physics 事件仍标 source:'physics'。
 * 4. LLM 失败 → 回退 mock（adjudicateMock 透传物理结果，绝不卡死）。
 *
 * @param llmService LLM 服务（测试可 mock）
 * @param config LLM 调用配置（导演部建议用 v4-pro，可配 thinking）
 */
export function createLlmDirectorRole(
  llmService: LlmService,
  config: LlmCallConfig,
): LlmDirectorRole {
  return {
    llm: llmService,
    config,
    async adjudicate(params) {
      try {
        return await adjudicateWithLlm(params, llmService, config)
      } catch (err) {
        if (isLlmCallError(err)) {
          // LLM 失败：回退 mock 透传（绝不卡死游戏）
          return adjudicateMock(params)
        }
        throw err
      }
    },
  }
}

/**
 * 真 LLM 终裁实现：director schema 输出 → 应用覆写 → 留痕 → 战报。
 *
 * 覆写留痕（审计教训「director 覆写必须留痕」）：
 * - overrides 应用到 finalResult.stateChanges.unitUpdates（按 field 路径 unitId.key）。
 * - 每条 override 转 source:'director' 事件入 event-log（含 before/after/reason）。
 * - appliedOverrides 返回供编排层写 directorMemory.overrides。
 *
 * 绝不伪造：overrides 仅修改 physicsResult 已涉及的单位（field 路径必须在真实 unit 上）。
 */
async function adjudicateWithLlm(
  params: DirectorAdjudicateParams,
  llmService: LlmService,
  config: LlmCallConfig,
): Promise<DirectorAdjudicateResult> {
  const { physicsResult, world, scenarioSeed, turn, envelopes, randomEvents, decisionTemplates } = params
  const validate = getAgentValidator('director') as ValidateFunction<DirectorAgentOutput>

  // 第 2 批：随机事件 effects 作为已确定的覆写（确定性真相，导演部在叙事中体现）。
  // 合并顺序：随机事件 effects（先，确定性）+ LLM 自身覆写（后，叙事层）。
  // 注意：LLM 覆写可能与随机事件 effect 冲突同一字段——以 LLM 覆写为最终真相
  // （导演层记录即真相，回放采信最终合并后的 overrides）。
  const randomEventOverrides: DirectorOverride[] = []
  const randomEventNarratives: string[] = []
  for (const ev of randomEvents ?? []) {
    randomEventOverrides.push(...ev.effects)
    randomEventNarratives.push(
      `[${ev.label}] ${ev.description}（effects: ${ev.effects
        .map((e) => `${e.field}=${JSON.stringify(e.before)}→${JSON.stringify(e.after)}`)
        .join(', ')}）`,
    )
  }

  // L3 任务文本：物理结算结果 + 锁定指令 + 回合号（属 L3 安全）
  const physicsBrief = JSON.stringify({
    turn: physicsResult.turn,
    events: physicsResult.events.map((e) => ({
      kind: e.kind,
      description: e.description,
      sequence: e.sequence,
    })),
    stateChanges: {
      annihilated: physicsResult.stateChanges.annihilated,
      objectiveChanges: physicsResult.stateChanges.objectiveChanges,
    },
    success: physicsResult.success,
  })
  const ordersBrief = JSON.stringify(
    envelopes.map((e) => ({ faction: e.faction, intent: e.intent, sequence: e.sequence })),
  )
  // 第 2 批：随机事件段落（导演部在战报中描述事件 + 体现 effects 影响）
  const randomEventsBrief =
    randomEventNarratives.length > 0
      ? `\n本回合随机事件（已确定，请在战报中体现，effects 已应用）：\n${randomEventNarratives.join('\n')}`
      : ''
  const task = `回合 ${turn}。请对以下物理结算结果进行终裁，产出叙事战报（reportText），必要时覆写数值（overrides，每条必含 field/before/after/reason），并记录关键事件（keyEvents）。\n物理结算：${physicsBrief}\n锁定指令：${ordersBrief}${randomEventsBrief}`

  const opts = buildLlmOptions(config, 'director', world, task)

  // 真流式战报：若调用方提供了 onReportChunk，用增量流式消费（边出边显示）。
  // 增量通过 onDelta 原样转发；完整文本到齐后再 parseLLMJson + schema 校验。
  // 注意：流式输出可能是部分 JSON，onReportChunk 转发原始增量（早期可能不可读，
  // 但 TTFT<200ms 的目标是"开始有东西流出"，而非完整可读）。UI 层按需截断展示。
  let data: DirectorAgentOutput
  if (params.onReportChunk) {
    const { text } = await llmService.streamTextWithDeltas(opts, (chunk) => {
      params.onReportChunk!(chunk)
    })
    try {
      data = parseLLMJson<DirectorAgentOutput>(text, validate)
    } catch (err) {
      // 校验失败：绝不伪造，重新抛 LlmJsonParseError（上层 isLlmCallError 不捕获 → 回退 mock）
      throw err instanceof LlmJsonParseError
        ? err
        : new LlmJsonParseError(
            err instanceof Error ? err.message : String(err),
            null,
          )
    }
  } else {
    // 非流式路径：保持原 streamChatStructured（schema 校验 + 缓存统计）
    const structured = await llmService.streamChatStructured<DirectorAgentOutput>(opts, validate)
    data = structured.data
  }

  // 1. 应用 overrides 到 finalResult（覆写留痕）
  // 第 2 批：随机事件 effects 先应用（确定性真相，已包含在 randomEventOverrides），
  // 再应用 LLM 自身覆写（叙事层，可与随机事件 effect 同字段，LLM 覆写为最终真相）。
  const llmOverrides = data.overrides ?? []
  const mergedOverrides = [...randomEventOverrides, ...llmOverrides]
  const finalResult = applyOverridesToResult(physicsResult, mergedOverrides)

  // 2. 战报摘要（reportText 来自 LLM 润色）
  const resolutionSummary = buildResolutionSummaryFromReport(
    finalResult,
    world,
    turn,
    data.reportText,
  )

  // 3. 事件：physics 事件（source:'physics'）+ director 覆写事件（source:'director'）+ 战报事件
  const directorEvents: AgentAction[] = []
  directorEvents.push(...physicsEventsToAgentActions(finalResult.events, scenarioSeed, turn))
  directorEvents.push(...overridesToDirectorActions(mergedOverrides, scenarioSeed, turn, envelopes.length))
  directorEvents.push(
    reportToDirectorAction(data.reportText, scenarioSeed, turn, data.keyEvents ?? []),
  )

  // 第 2 批：随机事件 effects 转为 'random_event' ResolutionEvent（source:'director'，回放采信）
  for (const ev of randomEvents ?? []) {
    directorEvents.push(randomEventToDirectorAction(ev, scenarioSeed, turn))
  }

  // 第 3 批：战术决策触发判定（与 mock 路径一致，按模板 triggerCondition + 当前态势产出）。
  // LLM 路径仅用模板触发，选项与后果复用模板（保证确定性：决策后果可重放，不依赖 LLM 输出）。
  const pendingDecision = generateTacticalDecision(world, turn, decisionTemplates ?? [])

  return {
    finalResult,
    resolutionSummary,
    directorEvents,
    appliedOverrides: mergedOverrides,
    keyEvents: data.keyEvents ?? [],
    pendingDecision,
  }
}

/**
 * 把 director overrides 应用到 finalResult.stateChanges（覆写留痕）。
 *
 * field 路径约定：`units.<unitId>.<field>`（如 units.first-armor.strength）。
 * 仅修改真实存在的 unit（绝不伪造单位）；非法路径跳过（绝不伪造）。
 */
function applyOverridesToResult(
  physicsResult: ResolutionResult,
  overrides: readonly DirectorOverride[],
): ResolutionResult {
  if (overrides.length === 0) return physicsResult
  // 浅拷贝 stateChanges + unitUpdates（不可变产出）
  const unitUpdates = { ...physicsResult.stateChanges.unitUpdates }
  for (const ov of overrides) {
    const parsed = parseOverrideField(ov.field)
    if (!parsed) continue // 非法路径跳过（绝不伪造）
    const { unitId, field } = parsed
    // 仅当该 unitId 在 unitUpdates 已存在或 world 有此单位时才写
    // （physicsResult 不含 world，此处宽容：任何 unitId 都允许写，由上层 world 校验）
    const existing = unitUpdates[unitId] ?? {}
    unitUpdates[unitId] = { ...existing, [field]: ov.after }
  }
  return {
    ...physicsResult,
    stateChanges: { ...physicsResult.stateChanges, unitUpdates },
  }
}

/** 解析 override field 路径 `units.<unitId>.<field>` → { unitId, field }。 */
function parseOverrideField(
  field: string,
): { unitId: string; field: string } | null {
  const parts = field.split('.')
  if (parts.length < 3) return null
  if (parts[0] !== 'units') return null
  return { unitId: parts[1], field: parts.slice(2).join('.') }
}

/**
 * 从 LLM reportText 构造战报摘要（reportText 取代 mock 拼装）。
 *
 * 战损/占领变更仍从 physicsResult 真实数据汇总（不伪造）。
 */
function buildResolutionSummaryFromReport(
  result: ResolutionResult,
  world: WorldState,
  turn: number,
  reportText: string,
): ResolutionSummary {
  // 复用 mock 的战损/占领汇总逻辑
  const base = buildResolutionSummary(result, world, turn)
  return {
    ...base,
    reportText, // LLM 润色战报覆盖 mock 拼装文本
    degraded: false,
  }
}

/**
 * 把 overrides 转为 source:'director' 事件（覆写留痕，落 event-log）。
 *
 * sequence 用 director 段位（3000+），每条覆写占一个槽。
 */
function overridesToDirectorActions(
  overrides: readonly DirectorOverride[],
  scenarioSeed: string,
  turn: number,
  _envelopeCount: number,
): AgentAction[] {
  return overrides.map((ov, i) => {
    const sequence = 3000 + i
    return {
      id: `evt:${sequence}:director-override:${i}`,
      turn,
      agentId: 'director-llm',
      agentRole: 'director',
      kind: 'adjudication',
      source: 'director' as const,
      payload: {
        kind: 'override',
        field: ov.field,
        before: ov.before,
        after: ov.after,
        reason: ov.reason,
      },
      text: `[导演部覆写] ${ov.field}: ${JSON.stringify(ov.before)} → ${JSON.stringify(ov.after)}（${ov.reason}）`,
      sequence,
      seed: `${scenarioSeed}:${turn}:${sequence}`,
    }
  })
}

/**
 * 把 LLM reportText 转为 source:'director' 战报事件（流式战报落 event-log）。
 *
 * sequence 用 director 段位互斥槽位 3997（见 SEQUENCE_DIRECTOR_* 常量族，
 * 与 mock 压缩/真压缩/fallback notice 互斥，避免同回合重复 event id）。
 */
function reportToDirectorAction(
  reportText: string,
  scenarioSeed: string,
  turn: number,
  keyEvents: string[],
): AgentAction {
  // P1-6 槽位互斥：director report 固定 3997
  const sequence = SEQUENCE_DIRECTOR_REPORT
  return {
    id: `evt:${sequence}:director-report:0`,
    turn,
    agentId: 'director-llm',
    agentRole: 'director',
    kind: 'report',
    source: 'director' as const,
    payload: {
      kind: 'report',
      keyEvents,
    },
    text: reportText,
    sequence,
    seed: `${scenarioSeed}:${turn}:${sequence}`,
  }
}

/**
 * 第 2 批：把已触发的随机事件转为 source:'director' 的 'random_event' AgentAction。
 *
 * 落 event-log 供回放采信（random_event 不重算，effects 原文直接应用）。
 * sequence 用 director 段位 4001+（与 3997-4000 段位区分，多事件按 index 偏移）。
 *
 * payload 形如：
 * {
 *   kind: 'random_event',
 *   description: '事件描述',
 *   data: {
 *     eventId, eventKind, label,
 *     effects: DirectorOverride[],
 *     reinforcementUnitIds: string[],
 *     reinforcementUnits: CampaignUnit[]  // 完整定义，供回放重建援军
 *   }
 * }
 *
 * replay.applyResolutionEvent 的 'random_event' case 据此重建覆写 + 注入援军（采信 log）。
 */
function randomEventToDirectorAction(
  ev: RandomEvent,
  scenarioSeed: string,
  turn: number,
): AgentAction {
  const sequence = SEQUENCE_DIRECTOR_RANDOM_EVENT_BASE
  // id 含 turn + eventId，保证跨回合（同一事件多次触发）event-log 主键唯一
  return {
    id: `evt:${turn}:${sequence}:random-event:${ev.id}`,
    turn,
    agentId: 'director-random-events',
    agentRole: 'director',
    kind: 'adjudication',
    source: 'director' as const,
    payload: {
      kind: 'random_event',
      description: ev.description,
      data: {
        eventId: ev.id,
        eventKind: ev.kind,
        label: ev.label,
        effects: ev.effects,
        reinforcementUnitIds: ev.reinforcementUnitIds ?? [],
        // 完整援军定义（供回放重建援军单位，采信 log 不重算）
        reinforcementUnits: ev.reinforcementUnits ?? [],
      },
    },
    text: `[随机事件] ${ev.label}：${ev.description}`,
    sequence,
    seed: `${scenarioSeed}:${turn}:${sequence}`,
  }
}

/**
 * M2 mock 终裁实现（纯函数，可单测）。
 *
 * 不覆写任何数值，直接采信物理结果。战报从 events 拼装。
 * 第 2 批：随机事件 effects 仍应用（确定性真相，mock 与 LLM 路径行为一致），
 * 并产出 'random_event' AgentAction 入 event-log。
 * 第 3 批：按 rules.decisions 模板判定是否触发本回合战术决策，
 * 触发则产出 TacticalDecision（pendingDecision）由编排器 OFFER_DECISION 挂起。
 */
function adjudicateMock(params: DirectorAdjudicateParams): DirectorAdjudicateResult {
  const { physicsResult, world, scenarioSeed, turn, randomEvents, decisionTemplates } = params

  // 1. 终裁：M2 应用随机事件 effects（确定性真相），其余直接采信物理结果。
  const randomEventOverrides: DirectorOverride[] = []
  for (const ev of randomEvents ?? []) {
    randomEventOverrides.push(...ev.effects)
  }
  const finalResult: ResolutionResult = applyOverridesToResult(
    physicsResult,
    randomEventOverrides,
  )

  // 2. 构造战报摘要（从 events 汇总战损/占领）
  const resolutionSummary = buildResolutionSummary(finalResult, world, turn)

  // 3. 构造导演部事件：把 physics events 转为 AgentAction（source:'physics'）入 event-log。
  //    M3 时导演部可额外产出 source:'director' 事件（覆写/润色）。
  const directorEvents = physicsEventsToAgentActions(finalResult.events, scenarioSeed, turn)

  // 第 2 批：随机事件转为 'random_event' AgentAction（source:'director'，回放采信）
  for (const ev of randomEvents ?? []) {
    directorEvents.push(randomEventToDirectorAction(ev, scenarioSeed, turn))
  }

  // 第 3 批：战术决策触发判定（确定性：turn_in 或 morale_below，非随机）。
  // mock 与 LLM 路径行为一致：均按模板 triggerCondition + 当前态势产出决策。
  const pendingDecision = generateTacticalDecision(world, turn, decisionTemplates ?? [])

  return { finalResult, resolutionSummary, directorEvents, pendingDecision }
}

// =============================================================================
// 第 3 批：战术决策生成（纯函数，按模板 + 当前态势产出运行时 TacticalDecision）
// =============================================================================

/**
 * 按模板 + 当前回合/态势判定是否触发战术决策，触发则产出运行时 TacticalDecision。
 *
 * 判定规则（确定性，非随机）：
 * - 'turn_in'：turn 在 triggerCondition.turns 列表中即触发（如第 3/10 回合历史节点）。
 * - 'morale_below'：某阵营平均士气低于 moraleThreshold 时触发（动态态势）。
 *
 * 一个回合至多触发一个决策（取第一个匹配的模板，避免 UI 决策面板拥挤）。
 *
 * 选项的 overrides 从模板解析：模板用 `__add_N__`（增量）/ `__current__`（占位）约定，
 * 此处按当前 world 把占位符解析为具体 DirectorOverride（field=units.<id>.<field>）：
 * - before：从 world.units 取当前值（找不到单位则跳过该 override）。
 * - after：`__add_N__` → before + N；其它（已是具体值）→ 原值。
 *
 * 仅保留单位真实存在的 override（绝不伪造单位）。
 *
 * @param world 当前世界状态（读 units 取 before 值）
 * @param turn 本回合号
 * @param templates 战役决策模板列表（来自 rules.decisions）
 * @returns TacticalDecision 或 undefined（无匹配模板）
 */
export function generateTacticalDecision(
  world: WorldState,
  turn: number,
  templates: readonly TacticalDecisionTemplate[],
): TacticalDecision | undefined {
  for (const tpl of templates) {
    if (!shouldTriggerDecision(tpl, world, turn)) continue
    const decision = resolveDecisionTemplate(tpl, world, turn)
    if (decision) return decision
  }
  return undefined
}

/** 判定某决策模板本回合是否触发（按 triggerCondition）。 */
function shouldTriggerDecision(
  tpl: TacticalDecisionTemplate,
  world: WorldState,
  turn: number,
): boolean {
  const cond = tpl.triggerCondition
  if (cond.kind === 'turn_in') {
    return (cond.turns ?? []).includes(turn)
  }
  if (cond.kind === 'morale_below') {
    if (!cond.factionId || cond.moraleThreshold === undefined) return false
    const factionUnits = world.units.filter((u) => u.factionId === cond.factionId)
    if (factionUnits.length === 0) return false
    const avgMorale =
      factionUnits.reduce((sum, u) => sum + u.morale, 0) / factionUnits.length
    return avgMorale < (cond.moraleThreshold ?? 0)
  }
  return false
}

/**
 * 把决策模板解析为运行时 TacticalDecision（overrides 已解析到具体单位）。
 *
 * 返回 undefined 当且仅当所有选项的 overrides 都解析失败（无任何单位命中）。
 */
function resolveDecisionTemplate(
  tpl: TacticalDecisionTemplate,
  world: WorldState,
  turn: number,
): TacticalDecision | undefined {
  const options = tpl.options
    .map((optTpl) => {
      const overrides: DirectorOverride[] = []
      for (const ovTpl of optTpl.overrides) {
        const resolved = resolveOverrideTemplate(ovTpl, world)
        if (resolved) overrides.push(resolved)
      }
      return {
        id: optTpl.id,
        label: optTpl.label,
        description: optTpl.description,
        overrides,
      }
    })
    // 仅保留至少有一条可解析 override 的选项（避免空后果选项误导玩家）
    .filter((opt) => opt.overrides.length > 0)

  if (options.length === 0) return undefined

  return {
    id: tpl.id,
    turn,
    label: tpl.label,
    description: tpl.description,
    options,
  }
}

/**
 * 解析单条 override 模板为具体 DirectorOverride。
 *
 * - field：`units.<unitId>.<field>` → 按 unitId 查 world.units。
 * - before：模板 `__current__` → 取 world 中单位当前值；其它 → 原值。
 * - after：模板 `__add_N__` → before + N（N 可负）；其它 → 原值。
 *
 * 单位不存在时返回 null（绝不伪造单位）。
 */
function resolveOverrideTemplate(
  ovTpl: TacticalDecisionTemplate['options'][number]['overrides'][number],
  world: WorldState,
): DirectorOverride | null {
  const parsed = parseDecisionField(ovTpl.field)
  if (!parsed) return null
  const { unitId, field } = parsed
  const unit = world.units.find((u) => u.id === unitId)
  if (!unit) return null
  const record = unit as unknown as Record<string, unknown>
  const currentValue = record[field]
  // before 解析：__current__ → 当前值；否则原值
  const before =
    ovTpl.before === '__current__' ? currentValue : ovTpl.before
  // after 解析：__add_N__ → before + N；否则原值
  let after: unknown = ovTpl.after
  if (typeof ovTpl.after === 'string') {
    const addMatch = /^__add_(-?\d+(?:\.\d+)?)__$/.exec(ovTpl.after)
    if (addMatch) {
      const delta = Number(addMatch[1])
      after =
        typeof before === 'number'
          ? before + delta
          : delta // before 非 number（异常）退化为 delta，保证有数值
    }
  }
  return {
    field: ovTpl.field,
    before,
    after,
    reason: ovTpl.reason,
  }
}

/** 解析 override field 路径 `units.<unitId>.<field>` → { unitId, field }。 */
function parseDecisionField(
  field: string,
): { unitId: string; field: string } | null {
  const parts = field.split('.')
  if (parts.length < 3) return null
  if (parts[0] !== 'units') return null
  return { unitId: parts[1], field: parts.slice(2).join('.') }
}

/**
 * 上下文压缩（M4-D，TDD §3.6 每 5 回合）。
 *
 * 规则引擎模板产出 ~500 tokens 态势总结（source:'rule-engine'，稳定可回放）：
 * 1. generateRuleEngineSummary 汇总近 {WINDOW} 回合关键事件 + 阵营态势 + 节点控制。
 * 2. applyContextSummary 产出新 contextSummaries（不可变）。
 * 3. 压缩事件标 source:'rule-engine'，sequence 用 director 段位 3998
 *    （P1-6 互斥槽位，与 context-compression.ts 真压缩 3999、report 3997 区分）。
 *
 * 落盘（写 factions/{factionId}/context-summary.md）由编排器经 gateway 完成
 * （本方法不直接调 Tauri；保持纯逻辑边界）。
 */
async function compressContextMock(
  world: WorldState,
  scenarioSeed: string,
  turn: number,
): Promise<ContextCompressionOutput> {
  const summary = generateRuleEngineSummary(world, turn)
  const newWorld = applyContextSummary(world, turn, summary)
  // 压缩事件（source:'rule-engine'，回放采信；sequence 用 director 段位 3998，互斥槽位）
  const sequence = SEQUENCE_DIRECTOR_MOCK_COMPRESS
  const event: AgentAction = {
    id: `evt:${sequence}:context-summary:${turn}`,
    turn,
    agentId: 'director-rule-engine',
    agentRole: 'director',
    kind: 'report',
    source: 'rule-engine',
    payload: {
      kind: 'report',
      keyEvents: [`上下文压缩：第 ${turn} 回合态势总结（~500 tokens）`],
    },
    text: summary,
    sequence,
    seed: `${scenarioSeed}:${turn}:${sequence}`,
  }
  return {
    summary,
    event,
    contextSummaries: newWorld.contextSummaries,
  }
}

/**
 * 从物理结算结果构造战报摘要（ResolutionSummary）。
 *
 * 战损：按 events 中的 engagement/casualty 数据汇总各方损失。
 * 占领变更：来自 stateChanges.objectiveChanges。
 * 战报文本：从 events 拼装人类可读摘要（M3 由 LLM 润色）。
 */
function buildResolutionSummary(
  result: ResolutionResult,
  world: WorldState,
  turn: number,
): ResolutionSummary {
  // 汇总战损：factionId → { personnel, strength }
  const casualties: ResolutionSummary['casualties'] = {}
  for (const evt of result.events) {
    if (evt.kind === 'engagement' && evt.data.attackerLoss !== undefined) {
      // 从攻防双方 id 反查 factionId
      const attackerId = String(evt.data.attackerId ?? '')
      const defenderId = String(evt.data.defenderId ?? '')
      const attacker = world.units.find((u) => u.id === attackerId)
      const defender = world.units.find((u) => u.id === defenderId)
      if (attacker) {
        accumulateCasualty(casualties, attacker.factionId, {
          personnel: Number(evt.data.attackerPersonnelLoss ?? 0),
          strength: Number(evt.data.attackerLoss ?? 0),
        })
      }
      if (defender) {
        accumulateCasualty(casualties, defender.factionId, {
          personnel: Number(evt.data.defenderPersonnelLoss ?? 0),
          strength: Number(evt.data.defenderLoss ?? 0),
        })
      }
    }
  }

  // 占领变更（stateChanges.objectiveChanges → ResolutionSummary.objectiveChanges）
  const objectiveChanges: ResolutionSummary['objectiveChanges'] = []
  const objectiveOwnership = new Map<string, string>()
  for (const change of result.stateChanges.objectiveChanges) {
    const from = objectiveOwnership.get(change.nodeId) ?? 'unknown'
    objectiveChanges.push({
      nodeId: change.nodeId,
      fromFactionId: from,
      toFactionId: change.toFactionId,
    })
    objectiveOwnership.set(change.nodeId, change.toFactionId)
  }

  // 战报文本：M2 从 events 拼装；M3 由 LLM 润色
  const reportText = buildReportText(result.events, turn)

  return {
    turn,
    casualties,
    objectiveChanges,
    reportText,
    degraded: !result.success,
  }
}

/** 累加战损到 casualties map。 */
function accumulateCasualty(
  casualties: ResolutionSummary['casualties'],
  factionId: string,
  delta: { personnel: number; strength: number },
): void {
  const cur = casualties[factionId] ?? { personnel: 0, strength: 0 }
  casualties[factionId] = {
    personnel: cur.personnel + delta.personnel,
    strength: cur.strength + delta.strength,
  }
}

/**
 * 从事件拼装战报文本（M2 规则拼装；M3 由 LLM 润色）。
 *
 * 保留每条事件的 description，按类别分组汇总。
 */
function buildReportText(events: readonly ResolutionEvent[], turn: number): string {
  if (events.length === 0) {
    return `第 ${turn + 1} 天：本日无战事。`
  }
  const lines: string[] = [`第 ${turn + 1} 天战报：`]
  for (const evt of events) {
    lines.push(`  - ${evt.description}`)
  }
  return lines.join('\n')
}

/**
 * 把物理层 ResolutionEvent 转为 AgentAction（标 source:'physics'）入 event-log。
 *
 * 回放规则（确定性两层）：physics 类事件回放时校验重算一致。
 */
function physicsEventsToAgentActions(
  events: readonly ResolutionEvent[],
  scenarioSeed: string,
  turn: number,
): AgentAction[] {
  return events.map((evt) => ({
    id: evt.id,
    turn,
    agentId: 'director-physics',
    agentRole: 'director',
    kind: 'adjudication',
    source: 'physics',
    payload: {
      kind: evt.kind,
      description: evt.description,
      data: evt.data,
    },
    text: evt.description,
    sequence: evt.sequence,
    seed: `${scenarioSeed}:${turn}:${evt.sequence}`,
  }))
}

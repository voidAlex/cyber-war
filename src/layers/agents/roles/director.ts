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
  const { physicsResult, world, scenarioSeed, turn, envelopes } = params
  const validate = getAgentValidator('director') as ValidateFunction<DirectorAgentOutput>

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
  const task = `回合 ${turn}。请对以下物理结算结果进行终裁，产出叙事战报（reportText），必要时覆写数值（overrides，每条必含 field/before/after/reason），并记录关键事件（keyEvents）。\n物理结算：${physicsBrief}\n锁定指令：${ordersBrief}`

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
  const overrides = data.overrides ?? []
  const finalResult = applyOverridesToResult(physicsResult, overrides)

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
  directorEvents.push(...overridesToDirectorActions(overrides, scenarioSeed, turn, envelopes.length))
  directorEvents.push(
    reportToDirectorAction(data.reportText, scenarioSeed, turn, data.keyEvents ?? []),
  )

  return {
    finalResult,
    resolutionSummary,
    directorEvents,
    appliedOverrides: overrides,
    keyEvents: data.keyEvents ?? [],
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
 * sequence 用 director 段位末尾槽（3000 + overrides.length + 1）。
 */
function reportToDirectorAction(
  reportText: string,
  scenarioSeed: string,
  turn: number,
  keyEvents: string[],
): AgentAction {
  const sequence = 3000 + 998 // 战报事件固定槽（不与覆写 3000+ 冲突）
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
 * M2 mock 终裁实现（纯函数，可单测）。
 *
 * 不覆写任何数值，直接采信物理结果。战报从 events 拼装。
 */
function adjudicateMock(params: DirectorAdjudicateParams): DirectorAdjudicateResult {
  const { physicsResult, world, scenarioSeed, turn } = params

  // 1. 终裁：M2 直接采信物理结果（不覆写）。M3 在此插入 LLM 覆写逻辑。
  const finalResult: ResolutionResult = physicsResult

  // 2. 构造战报摘要（从 events 汇总战损/占领）
  const resolutionSummary = buildResolutionSummary(finalResult, world, turn)

  // 3. 构造导演部事件：把 physics events 转为 AgentAction（source:'physics'）入 event-log。
  //    M3 时导演部可额外产出 source:'director' 事件（覆写/润色）。
  const directorEvents = physicsEventsToAgentActions(finalResult.events, scenarioSeed, turn)

  return { finalResult, resolutionSummary, directorEvents }
}

/**
 * 上下文压缩（M4-D，TDD §3.6 每 5 回合）。
 *
 * 规则引擎模板产出 ~500 tokens 态势总结（source:'rule-engine'，稳定可回放）：
 * 1. generateRuleEngineSummary 汇总近 {WINDOW} 回合关键事件 + 阵营态势 + 节点控制。
 * 2. applyContextSummary 产出新 contextSummaries（不可变）。
 * 3. 压缩事件标 source:'rule-engine'，sequence 用 director 段位 3999（回放采信）。
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
  // 压缩事件（source:'rule-engine'，回放采信；sequence 用 director 段位 3999）
  const sequence = 3999
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

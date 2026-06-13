/**
 * 导演部规则引擎兜底（director/rule-engine-fallback.ts）。
 *
 * 对应重写计划关键防坑「解析失败伪造 unit-1/C3」与修订点 E「离线可玩降级」：
 *
 * - LLM 失败 / 超时 / degraded 时，**绝不阻塞游戏**：采用物理引擎 rawResults +
 *   模板战报（`[规则引擎] 第N回合：...`），event-log 标 `source:'rule-engine'`。
 * - **绝不伪造**不存在的 unit / 坐标 / 节点（审计教训）：兜底产物只引用
 *   physicsResult 中已存在的真实事件数据，仅做文本拼装，不引入新实体。
 * - 战报文本前缀 `[规则引擎]` 便于 UI 明示「降级结算」（TDD §1.5）。
 *
 * 确定性两层（回放规则）：
 * - 兜底采用的 physicsResult 本身标 `source:'physics'`（可重算校验）。
 * - 兜底产出的战报/事件标 `source:'rule-engine'`（回放直接采信日志原文）。
 *
 * 本模块为纯函数：不调 Tauri/fetch/LLM/Date.now/随机数。
 *
 * @module layers/agents/director
 */

import type {
  ActionEnvelope,
  AgentAction,
  ResolutionSummary,
  WorldState,
} from '@/types'
import type { ResolutionResult, ResolutionEvent } from '@/layers/domain/combat'

// =============================================================================
// 兜底入参与产物
// =============================================================================

/** 规则引擎兜底入参（与 DirectorAdjudicateParams 对齐，便于编排层一键切换） */
export interface RuleEngineFallbackParams {
  /** 物理引擎结算结果（兜底直接采信，不覆写数值） */
  physicsResult: ResolutionResult
  /** 本回合锁定的命令（供战报引用真实指令，不伪造） */
  envelopes: ActionEnvelope[]
  /** 当前世界状态（只读，用于反查 factionId 等，绝不新增实体） */
  world: WorldState
  /** 场景种子（产出 AgentAction.seed 留痕用） */
  scenarioSeed: string
  /** 结算回合 */
  turn: number
  /**
   * 触发降级的原因（人类可读，写入战报头，便于 UI/diagnostics 追溯）。
   * 如 "LLM 超时" / "schema 校验失败" / "离线模式"。
   */
  degradeReason?: string
}

/** 规则引擎兜底产物（与 DirectorAdjudicateResult 结构对齐） */
export interface RuleEngineFallbackResult {
  /** 终裁结果（兜底直接采信 physicsResult，不覆写数值） */
  finalResult: ResolutionResult
  /** 战报摘要（degraded=true，模板战报） */
  resolutionSummary: ResolutionSummary
  /** 导演部事件（标 source:'rule-engine'，落 event-log） */
  directorEvents: AgentAction[]
}

// =============================================================================
// 主入口：ruleEngineFallback（保留旧无参桩的兼容名，新增结构化实现）
// =============================================================================

/**
 * 规则引擎兜底结算（纯函数）。
 *
 * 流程（**绝不伪造**）：
 * 1. 终裁：直接采信 physicsResult（不覆写数值；兜底不具备 LLM 覆写能力）。
 * 2. 战报：模板拼装 `[规则引擎] 第N回合：...`，引用 physics 真实事件描述；
 *    若无事件则写"无战事"。
 * 3. 事件：把 physics events 转为 AgentAction，**标 source:'rule-engine'**
 *    （区别于 director.ts mock 的 source:'physics'）；回放时直接采信。
 *
 * @param params 见 RuleEngineFallbackParams
 * @returns 兜底结算结果（degraded=true）
 */
export function ruleEngineFallback(
  params: RuleEngineFallbackParams,
): RuleEngineFallbackResult {
  const { physicsResult, world, scenarioSeed, turn, envelopes } = params

  // 1. 终裁：兜底直接采信物理结果（不覆写数值）
  const finalResult: ResolutionResult = physicsResult

  // 2. 模板战报（前缀 [规则引擎]，引用真实事件描述，不伪造）
  const resolutionSummary = buildRuleEngineSummary(
    finalResult,
    world,
    turn,
    params.degradeReason ?? 'LLM 不可用',
  )

  // 3. 事件标 source:'rule-engine'（回放直接采信）
  const directorEvents = physicsEventsToRuleEngineActions(
    finalResult.events,
    scenarioSeed,
    turn,
  )

  // 4. 额外产出一条兜底说明事件（记录降级原因，便于 UI/diagnostics 追溯）
  directorEvents.push(makeFallbackNotice(scenarioSeed, turn, params.degradeReason, envelopes.length))

  return { finalResult, resolutionSummary, directorEvents }
}

// =============================================================================
// 战报摘要构造（模板，标 degraded=true）
// =============================================================================

/**
 * 从物理结算结果构造兜底战报摘要。
 *
 * 与 director.ts 的 buildResolutionSummary 同构，但：
 * - reportText 前缀 `[规则引擎]`。
 * - degraded=true（明示降级结算）。
 * - 战损/占领变更数据完全来自 physicsResult 真实事件，不伪造。
 */
function buildRuleEngineSummary(
  result: ResolutionResult,
  world: WorldState,
  turn: number,
  degradeReason: string,
): ResolutionSummary {
  // 战损：按 events 中的 engagement/casualty 真实数据汇总（不伪造）
  const casualties: ResolutionSummary['casualties'] = {}
  for (const evt of result.events) {
    if (evt.kind === 'engagement' && evt.data.attackerLoss !== undefined) {
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

  // 占领变更（来自 physics 真实 stateChanges.objectiveChanges）
  const objectiveChanges: ResolutionSummary['objectiveChanges'] = []
  const ownership = new Map<string, string>()
  for (const change of result.stateChanges.objectiveChanges) {
    objectiveChanges.push({
      nodeId: change.nodeId,
      fromFactionId: ownership.get(change.nodeId) ?? 'unknown',
      toFactionId: change.toFactionId,
    })
    ownership.set(change.nodeId, change.toFactionId)
  }

  // 模板战报（前缀 [规则引擎]，引用真实事件描述，不伪造）
  const reportText = buildRuleEngineReportText(result.events, turn, degradeReason)

  return {
    turn,
    casualties,
    objectiveChanges,
    reportText,
    degraded: true, // 明示降级结算
  }
}

/** 累加战损（纯辅助）。 */
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
 * 模板战报文本（前缀 `[规则引擎]`）。
 *
 * 引用 physics 真实事件描述（不伪造）；空事件写"无战事"。
 * 头部注明降级原因，便于玩家理解为何是模板战报。
 */
function buildRuleEngineReportText(
  events: readonly ResolutionEvent[],
  turn: number,
  degradeReason: string,
): string {
  const head = `[规则引擎] 第 ${turn + 1} 天（降级结算：${degradeReason}）`
  if (events.length === 0) {
    return `${head}\n本日无战事。`
  }
  const lines: string[] = [head]
  for (const evt of events) {
    lines.push(`  - ${evt.description}`)
  }
  return lines.join('\n')
}

// =============================================================================
// 事件转换：physics events → AgentAction（标 source:'rule-engine'）
// =============================================================================

/**
 * 把物理层 ResolutionEvent 转为 AgentAction，标 source:'rule-engine'。
 *
 * 与 director.ts physicsEventsToAgentActions 同构，但 source 不同：
 * - director mock：source:'physics'（可重算校验）
 * - 规则引擎兜底：source:'rule-engine'（回放直接采信）
 *
 * 注意：事件 id/sequence/data 完全沿用 physics 真实数据，绝不伪造新事件。
 */
function physicsEventsToRuleEngineActions(
  events: readonly ResolutionEvent[],
  scenarioSeed: string,
  turn: number,
): AgentAction[] {
  return events.map((evt) => ({
    id: evt.id,
    turn,
    agentId: 'director-rule-engine',
    agentRole: 'director',
    kind: 'adjudication',
    source: 'rule-engine', // 关键：明示降级来源
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

/**
 * 构造一条兜底说明事件（记录降级原因，sequence 用 director 段位预留槽）。
 *
 * 仅留痕用，不含任何伪造的游戏数据。sequence 固定为 director 段位内的
 * 一个保留槽（SEQUENCE_BASE.director + 999），避免与真实覆写事件冲突。
 */
function makeFallbackNotice(
  scenarioSeed: string,
  turn: number,
  reason: string | undefined,
  envelopeCount: number,
): AgentAction {
  const sequence = 3000 + 999 // director 段位预留槽（不与正常覆写 3000+ 冲突）
  const reasonText = reason ?? 'LLM 不可用'
  return {
    id: `evt:${sequence}:rule-engine-notice:0`,
    turn,
    agentId: 'director-rule-engine',
    agentRole: 'director',
    kind: 'report',
    source: 'rule-engine',
    payload: {
      kind: 'rule-engine-notice',
      reason: reasonText,
      envelopeCount,
    },
    text: `[规则引擎] 已降级结算（${reasonText}），共 ${envelopeCount} 条指令按物理规则结算。`,
    sequence,
    seed: `${scenarioSeed}:${turn}:${sequence}`,
  }
}

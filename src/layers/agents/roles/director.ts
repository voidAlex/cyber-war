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
}

/**
 * 导演部终裁结果。
 *
 * M2：finalResult = physicsResult（不覆写）；reportText 由 events 拼装。
 * M3：可覆写 stateChanges（留痕），reportText 由 LLM 润色。
 */
export interface DirectorAdjudicateResult {
  /** 终裁后的最终结算结果（M2=physicsResult 透传） */
  finalResult: ResolutionResult
  /** 战报摘要（briefing 阶段展示） */
  resolutionSummary: ResolutionSummary
  /** 导演部产出的事件（M2 仅复制 physics 事件为 AgentAction 入 event-log） */
  directorEvents: AgentAction[]
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
 * 默认导演部实例（M2 mock）。
 * 直接 import 此实例即可使用；测试/替换时用 createDirectorRole() 重建。
 */
export const directorRole: DirectorRole = createDirectorRole()

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

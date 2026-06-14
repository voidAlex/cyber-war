/**
 * 上下文压缩（context-compression.ts）— TDD §3.6「上下文压缩策略」。
 *
 * 触发条件：每 5 回合（turnIndex % 5 === 0 且 turnIndex > 0）。
 * 执行者：导演部 Agent（在 briefing 阶段）。
 * 流程：
 *  1. 汇总最近 5 回合的关键事件（directorMemory.keyEvents）+ 当前世界态势。
 *  2. 产出「当前态势总结」(~500 tokens)：
 *     - LLM 可用时由 LLM 生成（source:'director'）；
 *     - 离线/降级时用规则模板生成（source:'rule-engine'）。
 *  3. 写 factions/{factionId}/context-summary.md（经 gateway fs_write_faction_file）。
 *  4. 更新 worldState.contextSummaries[turn]（作为新的稳定 L2 前缀，见 §9.3）。
 *
 * 确定性（重写计划修订决策#7）：
 * - 压缩产物「记录即真相」。回放时 director 摘要从 event-log 读，不重算。
 * - 压缩事件标 source:'rule-engine' 或 source:'director'，入 event-log 供回放采信。
 *
 * 缓存优化（§9.3 强制规则4）：摘要产出后作为新的稳定 L2 前缀，
 * 旧历史压缩进摘要不再逐条放——既控制上下文膨胀，又提升缓存命中率（防前缀漂移）。
 *
 * @module layers/agents/roles/context-compression
 */

import type {
  AgentAction,
  WorldState,
} from '@/types'

// =============================================================================
// 常量
// =============================================================================

/** 压缩触发周期（每 N 回合，TDD §3.6） */
export const CONTEXT_COMPRESSION_INTERVAL = 5
/** 摘要覆盖的最近回合数（窗口） */
export const CONTEXT_COMPRESSION_WINDOW = 5

/**
 * 上下文压缩事件的 event-log sequence 固定槽（P1-6 互斥槽位）。
 *
 * 与 director 段位其他固定槽互斥（见 director.ts SEQUENCE_DIRECTOR_* 常量族）：
 *   3997：director 战报；3998：mock 压缩；3999：真压缩（本常量）；4000：兜底说明。
 */
export const SEQUENCE_CONTEXT_COMPRESSION = 3999

/** 摘要来源标签（与 event-log source 对齐） */
export type ContextSummarySource = 'director' | 'rule-engine'

/** 压缩结果 */
export interface ContextSummaryResult {
  /** 摘要文本（~500 tokens，作为 L2 稳定前缀） */
  summary: string
  /** 来源：director（LLM）或 rule-engine（规则模板） */
  source: ContextSummarySource
  /** 对应的 event-log 事件（回放采信，source 与上面一致） */
  event: AgentAction
}

// =============================================================================
// 纯函数：规则引擎模板摘要（离线/降级兜底）
// =============================================================================

/**
 * 判断当前回合是否应触发上下文压缩（turnIndex % 5 === 0 且 turnIndex > 0）。
 *
 * @param turnIndex 当前回合索引
 */
export function shouldCompressContext(turnIndex: number): boolean {
  return turnIndex > 0 && turnIndex % CONTEXT_COMPRESSION_INTERVAL === 0
}

/**
 * 计算压缩窗口的起始回合（不含）：summaryTurn - WINDOW .. summaryTurn - 1。
 *
 * @param summaryTurn 本轮压缩对应的回合（产出摘要覆盖到此回合为止的历史）
 */
export function compressionWindowStart(summaryTurn: number): number {
  return Math.max(0, summaryTurn - CONTEXT_COMPRESSION_WINDOW)
}

/**
 * 规则引擎模板生成「当前态势总结」（~500 tokens，source:'rule-engine'）。
 *
 * 纯函数：基于 worldState 固有字段（directorMemory.keyEvents / units / factions）汇总，
 * 不调 LLM/Tauri/Date.now/random。输出文本稳定可复现。
 *
 * 摘要结构：
 * 1. 局势概览（回合/日期/阵营数/单位数）
 * 2. 近 {WINDOW} 回合关键叙事事件（directorMemory.keyEvents，去重截断）
 * 3. 各阵营态势快照（指挥官/补给/对外信任度数值）
 * 4. 高价值节点控制现状
 *
 * @param world 当前世界状态（只读）
 * @param summaryTurn 本轮压缩回合（覆盖到此前 WINDOW 回合）
 */
export function generateRuleEngineSummary(
  world: WorldState,
  summaryTurn: number,
): string {
  const lines: string[] = []
  const windowStart = compressionWindowStart(summaryTurn)

  // 1. 局势概览
  lines.push(`# 态势总结：第 ${summaryTurn} 回合（${world.inGameDate}）`)
  lines.push(`覆盖窗口：第 ${windowStart}–${summaryTurn - 1} 回合。`)
  lines.push(`阵营 ${world.factions.length} / 单位 ${world.units.length}。`)
  lines.push('')

  // 2. 近窗口关键叙事事件（directorMemory.keyEvents，去重 + 截断控 token）
  lines.push('## 关键事件')
  const recentKeyEvents: string[] = []
  for (let t = windowStart; t < summaryTurn; t++) {
    const events = world.directorMemory.keyEvents[t]
    if (events) {
      for (const e of events) {
        if (!recentKeyEvents.includes(e)) {
          recentKeyEvents.push(`[T${t}] ${e}`)
        }
      }
    }
  }
  if (recentKeyEvents.length === 0) {
    lines.push('- 窗口内无显著叙事事件。')
  } else {
    // 截断控 token（保留最近 MAX_KEY_EVENTS 条）
    const MAX_KEY_EVENTS = 12
    const shown = recentKeyEvents.slice(-MAX_KEY_EVENTS)
    for (const e of shown) lines.push(`- ${e}`)
    if (recentKeyEvents.length > MAX_KEY_EVENTS) {
      lines.push(`-（另 ${recentKeyEvents.length - MAX_KEY_EVENTS} 条较早事件略）`)
    }
  }
  lines.push('')

  // 3. 各阵营态势快照（指挥官/补给/对外信任度）
  lines.push('## 阵营态势')
  for (const f of world.factions) {
    const cmd = f.commander
    const trustBrief = Object.entries(f.trust)
      .map(([k, v]) => `${k}:${v}`)
      .join('，')
    lines.push(
      `- ${f.name}（${f.side}）：指挥 ${cmd.name}（攻${cmd.aggression.toFixed(2)}/服${cmd.obedience.toFixed(2)}/${cmd.preferredTempo}）；` +
        `补给 物${f.supply.supplies}/弹${f.supply.ammunition}/燃${f.supply.fuel}；` +
        `信任 {${trustBrief || '无'}}。`,
    )
  }
  lines.push('')

  // 4. 高价值节点控制现状
  lines.push('## 节点控制')
  const nodes = world.map.highValueNodes
  if (nodes.length === 0) {
    lines.push('- 无高价值节点。')
  } else {
    for (const n of nodes) {
      lines.push(`- ${n.id}（${n.name}）。`)
    }
  }

  return lines.join('\n')
}

// =============================================================================
// 服务函数：压缩并落盘（经 gateway 写 faction 文件 + 返回更新后的 worldState）
// =============================================================================

/**
 * 压缩上下文摘要的服务函数入参。
 */
export interface CompressContextParams {
  /** 当前世界状态（只读；函数产出新的 contextSummaries，不原地改） */
  world: WorldState
  /** 场景固定种子（确定性：scenarioSeed:turn:seq） */
  scenarioSeed: string
  /** 本轮压缩回合（默认取 world.turnIndex） */
  turn: number
  /**
   * 写阵营文件回调：把摘要写入 factions/{factionId}/context-summary.md。
   * 由调用方注入（经 gateway fs_write_faction_file）。测试可 mock。
   *
   * 形如 async (factionId, content) => fsWriteFactionFile(saveId, factionId, content)
   */
  writeFactionFile: (factionId: string, content: string) => Promise<void>
}

/**
 * 压缩上下文摘要并落盘（每 5 回合，TDD §3.6）。
 *
 * 规则引擎路径（离线/降级兜底，标 source:'rule-engine'）：
 * 1. generateRuleEngineSummary 产出 ~500 tokens 摘要。
 * 2. 对每个阵营 writeFactionFile(factionId, summary)（context-summary.md）。
 * 3. 返回压缩结果（含 event + summary），供调用方：
 *    - 把 summary 写入 worldState.contextSummaries[turn]（L2 稳定前缀）；
 *    - 把 event 追加到 event-log（回放采信）。
 *
 * 本函数**不原地修改 world**——返回新 contextSummaries，由上层 reducer/编排器应用。
 *
 * @param params 见 CompressContextParams
 * @returns 压缩结果（summary + source + event + 新的 contextSummaries）
 */
export async function compressContextWithRuleEngine(
  params: CompressContextParams,
): Promise<
  ContextSummaryResult & {
    /** 更新后的 contextSummaries（深拷贝 + 追加本轮 summary） */
    contextSummaries: Record<number, string>
  }
> {
  const { world, scenarioSeed, turn, writeFactionFile } = params
  const summary = generateRuleEngineSummary(world, turn)

  // 落盘：每个阵营一份 context-summary.md（context-builder L2 读最新轮摘要）
  for (const f of world.factions) {
    await writeFactionFile(f.id, summary)
  }

  // 更新 contextSummaries（不可变产出）
  const contextSummaries: Record<number, string> = {
    ...world.contextSummaries,
    [turn]: summary,
  }

  // 压缩事件（source:'rule-engine'，回放采信；sequence 用 director 段位互斥槽 3999）
  const sequence = SEQUENCE_CONTEXT_COMPRESSION
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

  return { summary, source: 'rule-engine', event, contextSummaries }
}

/**
 * 构造写入 worldState.contextSummaries 的新世界状态（不可变）。
 *
 * 便捷工具：把压缩结果应用到 worldState（深拷贝 + 覆盖 contextSummaries）。
 * 由编排器/reducer 调用，确保 context-builder L2 在下一回合读到新摘要。
 *
 * @param world 原世界状态
 * @param turn 本轮压缩回合
 * @param summary 摘要文本
 */
export function applyContextSummary(
  world: WorldState,
  turn: number,
  summary: string,
): WorldState {
  return {
    ...world,
    contextSummaries: { ...world.contextSummaries, [turn]: summary },
  }
}

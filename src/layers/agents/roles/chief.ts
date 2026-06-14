/**
 * 参谋长角色（chief.ts）— 命令解析器（mock + 真 LLM 双实现）。
 *
 * 参谋长负责：解析玩家自然语言命令 → 握手反问 → 预演虚线 → 玩家确认。
 * 批量握手取代逐条（重写计划修订点 B）。
 *
 * 两种实现：
 * - **mock 解析**（createChiefRole / chiefRole）：规则解析（识别意图
 *   move/attack/capture_node/hold + 目标单位 + 目标坐标）。M2 默认，测试/离线兜底用。
 * - **真 LLM 解析**（createLlmChiefRole）：经 llm-service 调 streamChatStructured
 *   （chief schema + context-builder L0-L3 分层），失败时回退 mock（绝不伪造）。
 *
 * 审计教训「解析失败伪造 unit-1/C3」的对策：
 * - 解析基于真实 WorldState.units/map.highValueNodes 校验目标存在；
 * - 找不到目标单位/坐标越界/节点不存在 → 返回 ClarifyRequest，绝不编造数据；
 * - LLM 输出经 ajv 严格校验 + 真实性校验（unitId 必须存在于 world.units）。
 *
 * 接口设计：`parseCommand(input, ctx) => Promise<ParsedCommand | ClarifyRequest>`，
 * 两种实现签名一致（LLM 实现额外需注入 llmService + config）。
 *
 * @module layers/agents/roles/chief
 */

import type { ValidateFunction } from 'ajv'
import type {
  CommandIntent,
  ParseCommandResult,
  ParsedCommand,
  ClarifyRequest,
  GridCoord,
  WorldState,
  Unit,
} from '@/types'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from './llm-role-base'
import { buildLlmOptions } from './llm-role-base'
import {
  serializeCampaignData,
  serializeWorldSummary,
} from '@/layers/agents/protocol/context-builder'
import {
  getAgentValidator,
  type ChiefAgentOutput,
  type ChiefCandidateCommand,
} from '@/layers/agents/protocol/schema'
import { isLlmCallError } from './role-errors'

/**
 * 参谋长解析所需的世界状态视图（最小依赖，便于测试注入）。
 *
 * 实际传 WorldState 即可；此类型让测试可只构造必要字段。
 */
export interface ChiefParseContext {
  /** 当前世界状态（用于校验单位/节点/坐标存在） */
  world: WorldState
  /** 玩家阵营 id（解析时仅匹配玩家方可控单位） */
  playerFactionId: string
}

/**
 * 输入意图分类结果。
 *
 * - `'command'`：玩家在下达战术命令（含移动/攻击/占领/固守等意图词）→ 走 parseCommand。
 * - `'chat'`：玩家在对话/询问/闲聊（问候、问当前态势、问建议）→ 走 chat 自然语言回复。
 *
 * 这是 chief 在 parseCommand/chat 之前的「前置路由」：避免把"你好"误解析成命令。
 */
export type ChiefInputKind = 'command' | 'chat'

/**
 * 参谋长对话回复结果。
 *
 * LLM 或 mock 规则产出的自然语言文本（不伪造命令，仅对话）。
 * UI 把它渲染为参谋对话气泡，区别于候选命令卡片。
 */
export interface ChiefChatResult {
  /** 回复文本（参谋人格口吻，基于真实 world 状态） */
  text: string
  /** 来源：mock 规则模板 / LLM。便于 UI/日志区分 */
  source: 'mock' | 'llm'
}

/**
 * 参谋长角色实例（M2 mock，M3 可替换为 LLM 实现）。
 *
 * 无状态：每次 parseCommand/chat 独立解析，不持有会话历史。
 */
export interface ChiefRole {
  /**
   * 解析玩家自然语言命令。
   *
   * @param input 玩家原始自然语言（如「第一装甲师移动到 C3」）
   * @param ctx 世界状态视图（用于校验目标存在）
   * @returns 解析成功 ParsedCommand；模糊/失败 ClarifyRequest（不伪造数据）
   */
  parseCommand(input: string, ctx: ChiefParseContext): Promise<ParseCommandResult>

  /**
   * 与参谋长自然语言对话（询问态势/问候/闲聊）。
   *
   * 与 parseCommand 互补：parseCommand 把命令解析为结构化候选；
   * chat 回复自然语言（参谋口吻，基于真实 world 状态，不伪造命令）。
   *
   * 调用方应先用 {@link classifyInput} 判断输入类别再决定调哪个方法。
   *
   * @param input 玩家自然语言（如「你好 我们现在是什么状态」）
   * @param ctx 世界状态视图
   * @returns 对话回复文本（mock 模板 或 LLM 参谋人格回复）
   */
  chat(input: string, ctx: ChiefParseContext): Promise<ChiefChatResult>
}

/**
 * 意图关键词表（中文 + 英文别名，用于规则匹配）。
 * 顺序：更具体的意图在前（capture_node 优先于 move，避免「占领 C3」误判为 move）。
 */
const INTENT_KEYWORDS: ReadonlyArray<{ intent: CommandIntent; words: readonly string[] }> = [
  {
    intent: 'capture_node',
    words: ['占领', '夺取', '攻占', '夺占', '攻取', 'capture', 'seize', 'occupy'],
  },
  {
    intent: 'attack',
    words: ['攻击', '进攻', '打击', '突击', '交火', '歼击', 'attack', 'assault', 'engage', 'strike'],
  },
  {
    intent: 'move',
    words: ['移动', '机动', '前进', '推进', '行军', '开进', '转移到', '前往', 'move', 'march', 'advance', 'go to'],
  },
  {
    intent: 'hold',
    words: ['固守', '坚守', '防御', '驻守', '防守', '就地', '不动', 'hold', 'defend', 'stand'],
  },
]

/**
 * 对话/询问意图关键词（命中则判 chat，不进 parseCommand）。
 *
 * 包含问候、询问态势、求助建议等非命令性词汇。注意与 INTENT_KEYWORDS 互斥——
 * classifyInput 先判命令关键词命中，命中即 command；都不命中再看是否含对话词
 * （含对话词或纯无意义输入 → chat）。
 */
const CHAT_KEYWORDS: readonly string[] = [
  // 问候
  '你好', '您好', 'hi', 'hello', '嗨', '早', '晚上好', '下午好', '早上好',
  // 询问态势/状态
  '什么状态', '现状', '当前态势', '战况', '情况如何', '怎么样', '状态',
  '当前', '局势', '汇报', '报告',
  // 询问/建议
  '建议', '怎么办', '怎么看', '你觉得', '你认为', '有什么', '能做',
  // 闲聊/感谢
  '谢谢', '辛苦', '感谢', '再见', '拜拜', 'bye',
]

/**
 * 纯函数：判断玩家输入是「命令」还是「对话/询问」。
 *
 * 路由规则（先用规则省成本，LLM 判断更准但多一次调用）：
 * 1. 输入含任何命令意图关键词（移动/攻击/占领/固守等）→ `'command'`。
 * 2. 否则 → `'chat'`（包括问候、询问、闲聊、无意义输入）。
 *
 * 这样"你好 我们现在是什么状态"因无命令词 → chat，不会被误解析成命令。
 * "第一装甲师移动到 C3"含"移动"→ command。
 *
 * 注意：与 matchIntent 共用 INTENT_KEYWORDS 表，保证一致。
 *
 * @param input 玩家原始输入
 * @returns 'command' | 'chat'
 */
export function classifyInput(input: string): ChiefInputKind {
  const lower = input.trim().toLowerCase()
  if (lower.length === 0) return 'chat'
  // 命令意图词命中优先（哪怕同时含问候，也是命令）
  for (const { words } of INTENT_KEYWORDS) {
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) return 'command'
    }
  }
  // 无命令词 → 对话/询问（问候、问态势、闲聊、求助等）
  return 'chat'
}

/** @internal 内部用的"是否含对话关键词"判定，便于 mock chat 决定回复模板分支 */
function hasChatKeyword(input: string): boolean {
  const lower = input.trim().toLowerCase()
  for (const w of CHAT_KEYWORDS) {
    if (lower.includes(w.toLowerCase())) return true
  }
  return false
}

/**
 * 创建 M2 mock 参谋长（规则解析 + 模板对话）。
 *
 * M3 时替换为真 LLM 实现（保持 parseCommand/chat 签名不变）。
 */
export function createChiefRole(): ChiefRole {
  return {
    async parseCommand(input, ctx) {
      return parseCommandMock(input, ctx)
    },
    async chat(input, ctx) {
      return chatMock(input, ctx)
    },
  }
}

/**
 * 默认参谋长实例（M2 mock）。
 * 直接 import 此实例即可使用；测试/替换时用 createChiefRole() 重建。
 */
export const chiefRole: ChiefRole = createChiefRole()

// ============================================================================
// M3 真 LLM 参谋长（保留 mock 作为 fallback）
// ============================================================================

/**
 * 真 LLM 参谋长角色（M3）。
 *
 * parseCommand 经 llm-service 调 streamChatStructured（chief schema），
 * 把 LLM 候选命令逐条做**真实性校验**（unitId/node/coord 必须存在于 world），
 * 校验不过的候选降级为 clarify（绝不伪造）。
 *
 * 任何 LLM 错误（四分类/degraded/schema 校验失败）→ **回退 mock 解析**
 * （审计教训"不伪造"的兜底：宁可用规则解析也不让游戏卡死）。
 */
export interface LlmChiefRole extends ChiefRole {
  /** 注入的 LLM 服务 */
  readonly llm: LlmService
  /** 注入的 LLM 调用配置 */
  readonly config: LlmCallConfig
}

/**
 * 创建真 LLM 参谋长（M3）。
 *
 * @param llmService LLM 服务（测试可 mock）
 * @param config LLM 调用配置（provider/endpoint/model/apiKey）
 * @returns LlmChiefRole（parseCommand 失败自动回退 mock）
 */
export function createLlmChiefRole(
  llmService: LlmService,
  config: LlmCallConfig,
): LlmChiefRole {
  return {
    llm: llmService,
    config,
    async parseCommand(input, ctx) {
      try {
        return await parseCommandWithLlm(input, ctx, llmService, config)
      } catch (err) {
        // LLM 失败：回退 mock 规则解析（绝不伪造，绝不卡死游戏）。
        // 记录错误便于排查（原静默 fallback 难定位失败原因）。
        // eslint-disable-next-line no-console
        console.error('[chief] LLM 解析失败，回退 mock 规则解析:', err)
        if (isLlmCallError(err)) {
          return parseCommandMock(input, ctx)
        }
        throw err
      }
    },
    async chat(input, ctx) {
      try {
        return await chatWithLlm(input, ctx, llmService, config)
      } catch (err) {
        // LLM 失败：回退 mock 模板回复（绝不伪造命令，绝不卡死对话）。
        // eslint-disable-next-line no-console
        console.error('[chief] LLM 对话失败，回退 mock 模板回复:', err)
        if (isLlmCallError(err)) {
          return chatMock(input, ctx)
        }
        throw err
      }
    },
  }
}

/**
 * 真 LLM 解析实现（chief schema + context-builder + 真实性校验）。
 *
 * 流程：
 * 1. buildLlmOptions（L0-L3 分层 messages）→ streamChatStructured<ChiefAgentOutput>。
 * 2. 把 LLM 候选命令逐条做真实性校验：
 *    - unitIds 必须全部存在于玩家方 world.units；
 *    - targetCoord 必须在地图范围内；
 *    - targetUnitId/nodeId 必须存在于 world。
 *    校验不过的候选剔除；全部剔除则降级 clarify。
 * 3. 取首条通过校验的候选构造 ParsedCommand（与 mock 结构一致）。
 *
 * 校验失败/无候选 → 返回 clarify（不伪造）。
 *
 * @throws LlmCallError（四分类/degraded/schema 校验失败）由上层回退
 */
async function parseCommandWithLlm(
  input: string,
  ctx: ChiefParseContext,
  llmService: LlmService,
  config: LlmCallConfig,
): Promise<ParseCommandResult> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return clarify(input, '命令为空，请输入指令', [])
  }

  const validate = getAgentValidator('chief') as ValidateFunction<ChiefAgentOutput>
  const opts = buildLlmOptions(
    config,
    'chief',
    ctx.world,
    // L3 任务：解析玩家本条命令（回合号属 L3，放任务文本里安全）
    `请把以下玩家自然语言命令解析为候选结构化命令：\n"${trimmed}"`,
  )
  const { data } = await llmService.streamChatStructured<ChiefAgentOutput>(opts, validate)

  // 逐条真实性校验（绝不伪造不存在的单位/坐标/节点）
  const playerUnits = ctx.world.units.filter((u) => u.factionId === ctx.playerFactionId)
  const playerUnitIds = new Set(playerUnits.map((u) => u.id))
  const nodeIds = new Set(ctx.world.map.highValueNodes.map((n) => n.id))
  const allUnitIds = new Set(ctx.world.units.map((u) => u.id))

  const validCandidates: ChiefCandidateCommand[] = []
  for (const cand of data.candidates) {
    // unitIds 必须全部是玩家方真实单位
    if (cand.unitIds.length === 0 || !cand.unitIds.every((id) => playerUnitIds.has(id))) {
      continue
    }
    // attack 的 targetUnitId 必须是真实敌方单位
    if (cand.intent === 'attack') {
      if (!cand.targetUnitId || !allUnitIds.has(cand.targetUnitId)) continue
    }
    // capture_node 的 nodeId 必须是真实节点
    if (cand.intent === 'capture_node') {
      if (!cand.nodeId || !nodeIds.has(cand.nodeId)) continue
    }
    // move/capture 的 targetCoord 必须在范围内
    if (cand.targetCoord) {
      if (!isInBounds(cand.targetCoord, ctx.world.map.cols, ctx.world.map.rows)) continue
    }
    validCandidates.push(cand)
  }

  if (validCandidates.length === 0) {
    return clarify(
      input,
      data.note ?? 'LLM 解析未产生有效候选（目标单位/坐标/节点校验失败）',
      playerUnits.slice(0, 5).map((u) => `可用单位：${u.id}`),
    )
  }

  // 取首条通过校验的候选构造 ParsedCommand
  const first = validCandidates[0]
  return {
    kind: 'parsed',
    intent: first.intent as CommandIntent,
    targetUnitIds: first.unitIds,
    targetCoord: first.targetCoord,
    targetUnitId: first.targetUnitId,
    nodeId: first.nodeId,
    summary: first.summary,
    confidence: first.confidence,
  }
}

// ============================================================================
// 参谋长对话（chat）— LLM 实现 + mock 模板
// =============================================================================

/**
 * 参谋长对话的 L0 system prompt（人格 + 对话规则，完全固定，缓存友好）。
 *
 * 注意：与命令解析用的 CHIEF_SYSTEM_PROMPT 不同——对话人格更口语化，
 * 职责是回答态势/问候/给建议，而非解析结构化命令。
 * 禁注入回合号/时间戳（这些在 L3 任务文本里）。
 */
const CHIEF_CHAT_SYSTEM_PROMPT = [
  '你是玩家的参谋长（Chief of Staff），一位经验丰富、沉稳睿智的军事副手。',
  '职责：与指挥官（玩家）进行自然语言对话——回答态势询问、提供战术建议、汇报战况、回应问候。',
  '口吻：称玩家为「长官」，语气专业、简洁、有条理，适当带入军事术语，但不过度冗长。',
  '原则：',
  '- 仅基于上下文提供的真实世界状态回答，绝不虚构不存在的单位/阵地/战况。',
  '- 给建议时要有依据（援引当前单位位置、敌方态势、地形），不空谈。',
  '- 不主动下达命令或执行动作；玩家要下命令需用明确指令词（移动/攻击/占领/固守）。',
  '- 回复控制在 2-5 句，适合终端对话气泡展示。',
  '直接输出自然语言回复，不要输出 JSON 或其他格式。',
].join('\n')

/**
 * 真 LLM 参谋长对话实现。
 *
 * 与命令解析不同的 messages 构造：
 * - L0 用 CHIEF_CHAT_SYSTEM_PROMPT（对话人格，非命令解析人格）。
 * - L1/L2 复用 context-builder 的 serializeCampaignData/serializeWorldSummary
 *   （缓存前缀与命令解析共享，吃满缓存红利）。
 * - L3 是玩家原始问话（不要求 JSON，直接自然语言回复）。
 *
 * 用 llmService.streamText（非结构化）拿纯文本回复。
 * 失败抛 LlmCallError，由 createLlmChiefRole 上层回退 mock 模板。
 *
 * @throws LlmCallError（四分类/degraded）由上层回退 mock
 */
async function chatWithLlm(
  input: string,
  ctx: ChiefParseContext,
  llmService: LlmService,
  config: LlmCallConfig,
): Promise<ChiefChatResult> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    // 空输入直接走 mock（不浪费 LLM 调用）
    return chatMock(input, ctx)
  }

  // L0-L2 与命令解析共享缓存前缀；L3 是玩家问话
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: CHIEF_CHAT_SYSTEM_PROMPT },
    { role: 'system', content: `战役数据（本局冻结）：\n${serializeCampaignData(ctx.world)}` },
    {
      role: 'system',
      content: `当前世界状态摘要（本回合）：\n${serializeWorldSummary(ctx.world)}`,
    },
    {
      role: 'user',
      // 玩家问话作为 L3，回合号属 L3 安全（system prompt 不含回合号）
      content: `（当前第 ${ctx.world.turnIndex} 回合，${ctx.world.inGameDate}）\n指挥官说："${trimmed}"\n请以参谋长口吻回复。`,
    },
  ]

  const result = await llmService.streamText({
    provider: config.provider,
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    model: config.model,
    messages,
    // 对话用稍高温度增加自然度（命令解析用默认）；若 config 已设 extraParams 则合并
    extraParams: { temperature: 0.7, ...(config.extraParams ?? {}) },
  })

  const text = result.text.trim()
  if (text.length === 0) {
    // LLM 返回空：回退 mock（不伪造，用模板）
    return chatMock(input, ctx)
  }
  return { text, source: 'llm' }
}

/**
 * mock 参谋长对话（纯函数模板，离线/降级/LLM 失败时兜底）。
 *
 * 基于 world 真实状态生成回复，绝不伪造命令或编造不存在的态势。
 * 几个分支：
 * - 问候 → 回礼 + 简报当前态势。
 * - 问状态/战况 → 汇报回合、阵地、关键单位位置。
 * - 其他（建议/闲聊）→ 通用参谋口吻回复 + 引导下命令。
 */
function chatMock(input: string, ctx: ChiefParseContext): ChiefChatResult {
  const world = ctx.world
  const playerUnits = world.units.filter((u) => u.factionId === ctx.playerFactionId)
  const enemyUnits = world.units.filter((u) => u.factionId !== ctx.playerFactionId)
  const turn = world.turnIndex
  const date = world.inGameDate

  // 节点控制摘要（哪些节点名）
  const nodeName = (n: { name: string }): string => n.name

  if (hasChatKeyword(input)) {
    // 含问候/询问态势等对话词
    if (/你好|您好|hi|hello|嗨|早|晚上好|下午好|早上好/i.test(input)) {
      return {
        source: 'mock',
        text: `长官，参谋长报到。当前第 ${turn} 回合（${date}），我方尚有 ${playerUnits.length} 个建制可调动，当面之敌约 ${enemyUnits.length} 个建制。${world.map.highValueNodes.length > 0 ? `关键目标：${world.map.highValueNodes.slice(0, 3).map(nodeName).join('、')}。` : ''}请下令。`,
      }
    }
    if (/什么状态|现状|当前态势|战况|情况如何|怎么样|状态|当前|局势|汇报|报告/.test(input)) {
      // 汇报态势：列己方单位位置 + 敌方概数
      const unitBrief = playerUnits
        .slice(0, 4)
        .map((u) => `${UNIT_TYPE_CN[u.type] ?? u.type}（${u.coord.col},${u.coord.row}，强度${u.strength}）`)
        .join('；')
      return {
        source: 'mock',
        text: `长官，第 ${turn} 回合态势：我方${playerUnits.length > 0 ? `主力 ${unitBrief}` : '暂无可调单位'}。当面敌军约 ${enemyUnits.length} 个建制。${world.map.highValueNodes.length > 0 ? `争夺焦点：${world.map.highValueNodes.slice(0, 3).map(nodeName).join('、')}。` : ''}`,
      }
    }
    if (/建议|怎么办|怎么看|你觉得|你认为|有什么|能做/.test(input)) {
      return {
        source: 'mock',
        text: `长官，依参谋部判断：优先确保关键节点防御，再图反击。若要推进，可命装甲/步兵向目标格机动，炮兵提供火力支援。具体请下达命令（如「${UNIT_TYPE_CN[playerUnits[0]?.type ?? 'infantry'] ?? '步兵'}移动到 C3」）。`,
      }
    }
    // 谢谢/再见等其他对话词
    return {
      source: 'mock',
      text: `长官不必客气，参谋部随时待命。如需下令请直说，例如「某单位移动到某坐标」。`,
    }
  }

  // 无对话词、也不含命令词的输入（如纯符号、无意义短语）→ 通用引导
  return {
    source: 'mock',
    text: `长官，请明确指示：要下令（移动/攻击/占领/固守），还是询问当前态势？`,
  }
}

/**
 * M2 mock 解析实现（纯函数，可单测）。
 *
 * 解析步骤：
 * 1. 识别意图（关键词匹配，capture_node 优先）。
 * 2. 识别目标单位（按单位 id/name 关键词匹配玩家可控单位）。
 * 3. 按意图提取目标坐标/目标单位/节点 id，并校验存在。
 * 4. 任一关键信息缺失/不匹配 → 返回 ClarifyRequest。
 */
function parseCommandMock(
  input: string,
  ctx: ChiefParseContext,
): ParseCommandResult {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return clarify(input, '命令为空，请输入指令', [])
  }

  const playerUnits = ctx.world.units.filter((u) => u.factionId === ctx.playerFactionId)
  if (playerUnits.length === 0) {
    return clarify(input, '没有可供指挥的单位', [])
  }

  // 1. 识别意图
  const intent = matchIntent(trimmed)
  if (intent === null) {
    return clarify(
      input,
      '无法识别命令意图，请使用 移动/攻击/占领/固守 等关键词',
      ['例如：第一装甲师移动到 C3', '例如：炮兵团攻击敌方步兵师', '例如：占领杜奥蒙堡'],
    )
  }

  // 2. 识别目标单位（玩家可控）
  const matchedUnits = matchUnits(trimmed, playerUnits)
  if (matchedUnits.length === 0) {
    return clarify(
      input,
      '未匹配到任何己方单位，请指明具体单位',
      playerUnits.slice(0, 5).map((u) => `可用单位：${describeUnit(u)}`),
    )
  }

  // 3. 按意图提取并校验目标
  switch (intent) {
    case 'move': {
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      if (coord === null) {
        return clarify(
          input,
          '未解析到合法目标坐标，请指明目标格（如 C3）',
          [coordFormatHint(ctx.world.map.cols, ctx.world.map.rows)],
        )
      }
      const summary = matchedUnits.map((u) => u.id).join('、') + ` 移动到 (${coord.col},${coord.row})`
      return parsed('move', matchedUnits.map((u) => u.id), {
        targetCoord: coord,
        summary,
      })
    }

    case 'attack': {
      // 攻击：匹配敌方单位
      const enemyUnits = ctx.world.units.filter((u) => u.factionId !== ctx.playerFactionId)
      const target = matchUnits(trimmed, enemyUnits)[0]
      if (target === undefined) {
        return clarify(
          input,
          '未匹配到攻击目标（敌方单位），请指明敌方单位',
          enemyUnits.slice(0, 5).map((u) => `敌方单位：${describeUnit(u)}`),
        )
      }
      const summary = matchedUnits.map((u) => u.id).join('、') + ` 攻击 ${target.id}`
      return parsed('attack', matchedUnits.map((u) => u.id), {
        targetUnitId: target.id,
        summary,
      })
    }

    case 'capture_node': {
      // 占领：匹配高价值节点
      const node = matchNode(trimmed, ctx.world.map.highValueNodes)
      if (node === null) {
        return clarify(
          input,
          '未匹配到可占领的高价值节点，请指明节点名',
          ctx.world.map.highValueNodes.slice(0, 5).map((n) => `节点：${n.name}`),
        )
      }
      // 节点坐标：由 cellId 解析（cellId 格式约定 col:row，见 types/map 沙盘坐标）
      const nodeCoord = parseCellId(node.cellId)
      const summary = matchedUnits.map((u) => u.id).join('、') + ` 占领 ${node.name}`
      return parsed('capture_node', matchedUnits.map((u) => u.id), {
        nodeId: node.id,
        targetCoord: nodeCoord ?? undefined,
        summary,
      })
    }

    case 'hold': {
      const summary = matchedUnits.map((u) => u.id).join('、') + ' 就地固守'
      return parsed('hold', matchedUnits.map((u) => u.id), { summary })
    }

    default: {
      // 穷尽性检查
      const _exhaustive: never = intent
      void _exhaustive
      return clarify(input, '解析异常', [])
    }
  }
}

// ============================================================================
// 解析辅助（纯函数）
// ============================================================================

/**
 * 关键词匹配意图（capture_node 优先，避免「占领 C3」误判为 move）。
 * 返回 null 表示无任何意图关键词命中。
 */
function matchIntent(text: string): CommandIntent | null {
  const lower = text.toLowerCase()
  for (const { intent, words } of INTENT_KEYWORDS) {
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) {
        return intent
      }
    }
  }
  return null
}

/**
 * 匹配单位：按单位 id / type 中文名 / 关键词片段匹配。
 * 返回所有命中的单位（玩家可下指令给多个单位）。
 *
 * 禁止伪造：仅在传入的 units 中匹配，不虚构 id。
 */
function matchUnits(text: string, units: readonly Unit[]): Unit[] {
  const lower = text.toLowerCase()
  const matched: Unit[] = []
  for (const u of units) {
    // 单位 id 直接包含
    if (u.id.length > 0 && lower.includes(u.id.toLowerCase())) {
      matched.push(u)
      continue
    }
    // 单位类型中文名
    const typeName = UNIT_TYPE_CN[u.type]
    if (typeName !== undefined && lower.includes(typeName)) {
      matched.push(u)
      continue
    }
    // 单位类型英文名
    if (lower.includes(u.type)) {
      matched.push(u)
    }
  }
  // 去重（同一单位可能被多个关键词命中）
  return Array.from(new Set(matched))
}

/** 单位类型中文名表（匹配「装甲师」「步兵师」等自然描述） */
const UNIT_TYPE_CN: Record<Unit['type'], string> = {
  infantry: '步兵',
  armor: '装甲',
  artillery: '炮兵',
  recon: '侦察',
  fortress: '要塞',
  support: '后勤',
}

/**
 * 解析目标坐标（支持字母+数字「C3」「c3」与数字对「3,3」）。
 * 「C3」→ col=2(0-indexed C=第3列), row=2(0-indexed 第3行)。
 * 校验范围在 [0,cols)×[0,rows) 内；越界返回 null。
 *
 * 注意：A→col0，对应沙盘左侧第一列；与沙盘 coords.ts 渲染一致。
 */
function matchCoord(text: string, cols: number, rows: number): GridCoord | null {
  // 字母+数字：C3 / B7 / a1
  const letterMatch = text.match(/([A-Za-z])\s*(\d+)/)
  if (letterMatch !== null) {
    const colLetter = letterMatch[1].toUpperCase()
    const col = colLetter.charCodeAt(0) - 'A'.charCodeAt(0)
    const row = Number.parseInt(letterMatch[2], 10) - 1
    const coord = { col, row }
    if (isInBounds(coord, cols, rows)) return coord
  }
  // 数字对：(2,3) / 2 3 / 2,3
  const pairMatch = text.match(/\(?\s*(\d+)\s*[,，]\s*(\d+)\s*\)?/)
  if (pairMatch !== null) {
    const col = Number.parseInt(pairMatch[1], 10)
    const row = Number.parseInt(pairMatch[2], 10)
    const coord = { col, row }
    if (isInBounds(coord, cols, rows)) return coord
  }
  return null
}

/** 坐标是否在网格范围内。cols/rows 为 0 时（空地图）恒为越界。 */
function isInBounds(coord: GridCoord, cols: number, rows: number): boolean {
  if (cols <= 0 || rows <= 0) return false
  return coord.col >= 0 && coord.col < cols && coord.row >= 0 && coord.row < rows
}

/**
 * 匹配高价值节点（按节点 name 或 id 包含匹配）。
 * 找不到返回 null（绝不伪造节点）。
 */
function matchNode(
  text: string,
  nodes: ReadonlyArray<{ id: string; name: string; cellId: string }>,
): { id: string; name: string; cellId: string } | null {
  const lower = text.toLowerCase()
  // 先精确 name 包含，再 id 包含
  for (const n of nodes) {
    if (n.name.length > 0 && lower.includes(n.name.toLowerCase())) {
      return n
    }
  }
  for (const n of nodes) {
    if (n.id.length > 0 && lower.includes(n.id.toLowerCase())) {
      return n
    }
  }
  return null
}

/** 解析 cellId（约定格式 col:row）为坐标；非法返回 null。 */
function parseCellId(cellId: string): GridCoord | null {
  const parts = cellId.split(':')
  if (parts.length !== 2) return null
  const col = Number.parseInt(parts[0], 10)
  const row = Number.parseInt(parts[1], 10)
  if (Number.isNaN(col) || Number.isNaN(row)) return null
  return { col, row }
}

// ============================================================================
// 结果构造辅助
// ============================================================================

/** 构造解析成功结果。 */
function parsed(
  intent: CommandIntent,
  targetUnitIds: string[],
  extra: { targetCoord?: GridCoord; targetUnitId?: string; nodeId?: string; summary: string },
): ParsedCommand {
  return {
    kind: 'parsed',
    intent,
    targetUnitIds,
    targetCoord: extra.targetCoord,
    targetUnitId: extra.targetUnitId,
    nodeId: extra.nodeId,
    summary: extra.summary,
    confidence: 0.8,
  }
}

/** 构造需澄清结果。 */
function clarify(rawInput: string, reason: string, suggestions: string[]): ClarifyRequest {
  return { kind: 'clarify', rawInput, reason, suggestions }
}

/** 单位的人类可读描述（用于建议列表）。 */
function describeUnit(u: Unit): string {
  return `${u.id}（${UNIT_TYPE_CN[u.type] ?? u.type}，位于 ${u.coord.col},${u.coord.row}）`
}

/** 坐标格式提示。 */
function coordFormatHint(cols: number, rows: number): string {
  if (cols <= 0 || rows <= 0) return '当前地图为空，无法下移动命令'
  return `坐标格式：字母+数字（如 A1..${columnLetter(cols - 1)}${rows}）`
}

/** 把 0-based 列号转字母（0→A, 25→Z, 26→AA）。 */
function columnLetter(col: number): string {
  let s = ''
  let n = col
  do {
    s = String.fromCharCode('A'.charCodeAt(0) + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

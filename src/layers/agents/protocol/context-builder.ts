/**
 * Agent 协议 — context-builder（protocol/context-builder.ts）。
 *
 * **纯函数边界**：严格按 L0-L3 缓存分层构造 messages，让 prompt 前缀稳定且跨请求重复
 * （吃满 DeepSeek 等硬盘 KV 缓存红利）。
 *
 * 缓存分层（重写计划「DeepSeek 缓存极致优化」）：
 * | 层 | 稳定性 | 内容 | 缓存价值 |
 * |---|---|---|---|
 * | L0 永不变 | 永久 | 角色 system prompt（人格/职责/输出 JSON schema/规则文本） | 最高 |
 * | L1 每局不变 | 整局 | 战役设定/地图/阵营/装备库/数值规则 | 高（开局冻结） |
 * | L2 每回合变一次 | 每回合 | 世界状态摘要 + 上下文摘要（同回合多 Agent 共享） | 中 |
 * | L3 每次请求变 | 每请求 | 本条具体指令/任务 | 低（必然未命中） |
 *
 * 强制规则：
 * 1. system prompt **严格固定**，**禁止注入回合号/时间戳/UUID/当前回合数**
 *    （这些只能放 L3）。L0 内容由角色常量 + schema 说明拼接，永不含易变字段。
 * 2. 战役数据 L1 开局后冻结作为稳定前缀。
 * 3. 多 Agent 共享同一份 L0+L1+L2 前缀（互相命中）。
 * 4. messages 按 L0→L1→L2→L3 顺序构造，append-only。
 *
 * 本模块为纯函数：不调 Tauri/fetch/crypto/Date.now/random。
 *
 * @module layers/agents/protocol/context-builder
 */

import type {
  AgentContext,
  AgentMessage,
  AgentRole,
  WorldState,
  DialogueTurn,
} from '@/types'
import { AGENT_OUTPUT_SCHEMAS } from './schema'

// =============================================================================
// L0 system prompt 常量（永不变，缓存价值最高）
// =============================================================================
//
// 注意：此处所有字符串必须完全固定，禁注入回合号/时间戳/UUID/日期。
// schema 说明用「参见输出格式定义」措辞，具体 schema 文本作为独立 L0 消息，
// 保证 L0 在所有请求间字节级一致。

/** 参谋长（chief）人格与职责（L0 永久固定） */
const CHIEF_SYSTEM_PROMPT = [
  '你是参谋长（Chief of Staff）。',
  '职责：把玩家的自然语言命令解析为结构化的候选命令列表。',
  '原则：',
  '- 只能引用真实存在的单位 id 与高价值节点 id（来自上下文战役数据），绝不伪造不存在的单位或坐标。',
  '- 解析模糊时返回单条候选并附 note 说明需要澄清的点，绝不编造意图。',
  '- 每条候选命令给出自然语言 summary 与 confidence（0..1）。',
  '输出格式：严格 JSON，schema 见「输出格式定义」。不要输出 JSON 以外的解释文本。',
].join('\n')

/** 战区司令（theater）人格与职责（L0） */
const THEATER_SYSTEM_PROMPT = [
  '你是战区司令（Theater Commander）。',
  '职责：把已确认的候选命令拆解为单位级可执行动作（每个单位一条 action）。',
  '原则：',
  '- 仅引用真实单位 id；坐标必须落在地图范围内（见上下文战役数据）。',
  '- attack 指向的 targetUnitId 必须是敌方真实单位。',
  '输出格式：严格 JSON，schema 见「输出格式定义」。不要输出 JSON 以外的解释文本。',
].join('\n')

/** 敌/盟统帅（commander）人格与职责（L0） */
const COMMANDER_SYSTEM_PROMPT = [
  '你是某阵营统帅（Faction Commander）。',
  '职责：基于已知情报与本阵营人格，决定本阵营单位本回合的行动。',
  '原则：',
  '- 仅引用本阵营真实单位 id；目标单位/节点来自上下文真实数据。',
  '- 必须给出 rationale（基于人格 aggression/obedience 与态势的依据）。',
  '- obedience 低时可选择抗命（disobeying=true），director 会终裁。',
  '输出格式：严格 JSON，schema 见「输出格式定义」。不要输出 JSON 以外的解释文本。',
].join('\n')

/** 导演部（director）人格与职责（L0） */
const DIRECTOR_SYSTEM_PROMPT = [
  '你是导演部（Director）。',
  '职责：对物理结算结果进行终裁——产出叙事战报，必要时覆写数值（必须留痕）。',
  '原则：',
  '- reportText 是玩家可见的本回合战报，必须与物理结算一致，不得虚构未发生的事件。',
  '- 覆写数值（overrides）时每条必含 before/after/reason，reason 须具体可追溯。',
  '- keyEvents 记录本回合关键叙事标记，供后续回合上下文压缩使用。',
  '输出格式：严格 JSON，schema 见「输出格式定义」。不要输出 JSON 以外的解释文本。',
].join('\n')

/** 各角色 L0 system prompt（人格 + 职责） */
const ROLE_SYSTEM_PROMPTS: Record<AgentRole, string> = {
  chief: CHIEF_SYSTEM_PROMPT,
  theater: THEATER_SYSTEM_PROMPT,
  commander: COMMANDER_SYSTEM_PROMPT,
  director: DIRECTOR_SYSTEM_PROMPT,
}

/**
 * 各角色输出 schema 的「输出格式定义」文本（L0 第二段，固定不变）。
 *
 * 用 JSON.stringify 产出稳定文本，作为独立 system 消息，与人格消息拼接成完整 L0。
 * schema 对象本身是常量，故此文本完全固定 → 缓存命中。
 */
const ROLE_SCHEMA_TEXT: Record<AgentRole, string> = {
  chief: `输出格式定义（严格 JSON）：\n${JSON.stringify(AGENT_OUTPUT_SCHEMAS.chief)}`,
  theater: `输出格式定义（严格 JSON）：\n${JSON.stringify(AGENT_OUTPUT_SCHEMAS.theater)}`,
  commander: `输出格式定义（严格 JSON）：\n${JSON.stringify(AGENT_OUTPUT_SCHEMAS.commander)}`,
  director: `输出格式定义（严格 JSON）：\n${JSON.stringify(AGENT_OUTPUT_SCHEMAS.director)}`,
}

// =============================================================================
// L1 战役数据序列化（开局冻结，整局不变）
// =============================================================================

/**
 * 序列化战役数据为稳定的 L1 文本（开局冻结）。
 *
 * 注意：仅含开局固定的 map/factions 模板/装备规则等。**不包含当前回合状态**
 * （回合状态属于 L2）。此处产出在整局内字节级一致，最大化缓存命中。
 *
 * 由于战役数据 M2/M4 才完整定义，此处采用最小但稳定的序列化：
 * 取 scenarioId + scenarioSeed + 地图结构 + 阵营模板。任一字段开局后冻结。
 *
 * 排序：对数组按稳定字段（id）排序，避免顺序漂移破坏缓存前缀。
 */
export function serializeCampaignData(world: WorldState): string {
  const mapSummary = {
    gridType: world.map.gridType,
    cols: world.map.cols,
    rows: world.map.rows,
    // 仅节点 id 列表（开局冻结，稳定排序）
    highValueNodes: [...world.map.highValueNodes]
      .map((n) => n.id)
      .sort(),
  }
  // 阵营模板（开局固定的 id/side/personality，不含当前回合数值）
  const factionTemplates = [...world.factions]
    .map((f) => ({
      id: f.id,
      side: f.side,
      commander: {
        id: f.commander.id,
        personality: f.commander.personality,
        aggression: f.commander.aggression,
        obedience: f.commander.obedience,
        preferredTempo: f.commander.preferredTempo,
      },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return JSON.stringify({
    scenarioId: world.scenarioId,
    scenarioSeed: world.scenarioSeed,
    map: mapSummary,
    factionTemplates,
  })
}

// =============================================================================
// L2 世界状态摘要（每回合变一次，同回合多 Agent 共享）
// =============================================================================

/**
 * 序列化当前回合世界状态摘要为 L2 文本。
 *
 * 含当前回合单位位置/数值/节点控制/情报/上下文压缩摘要。
 * **同一回合内多 Agent 共享同一份 L2**（缓存互相命中）。
 *
 * 此处为最小摘要实现（M3 地基）：列出单位 id/阵营/坐标/关键数值 + 节点控制。
 * M4 上下文压缩（每 5 回合）产出后，压缩摘要作为更稳定的 L2 前缀。
 *
 * 注意：回合号 turnIndex 在这里是「当前世界状态的固有属性」，
 * 属于 L2（每回合变）而非 L0（永不变）——L0 禁止含回合号。
 */
export function serializeWorldSummary(world: WorldState): string {
  // 单位按 id 稳定排序，避免顺序漂移
  const unitSummary = [...world.units]
    .map((u) => ({
      id: u.id,
      factionId: u.factionId,
      type: u.type,
      coord: u.coord,
      strength: u.strength,
      personnel: u.personnel,
      morale: u.morale,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  // 节点控制（从单位 status 或节点 ownership 推断；此处最小实现用 highValueNodes id 列表）
  const nodeIds = [...world.map.highValueNodes].map((n) => n.id).sort()

  // 上下文压缩摘要（每 5 回合产出，作为稳定 L2 前缀）
  const sortedSummaryTurns = Object.keys(world.contextSummaries)
    .map(Number)
    .sort((a, b) => a - b)
  const latestSummaryTurn =
    sortedSummaryTurns.length > 0
      ? sortedSummaryTurns[sortedSummaryTurns.length - 1]
      : null
  const contextSummary =
    latestSummaryTurn !== null
      ? world.contextSummaries[latestSummaryTurn]
      : null

  return JSON.stringify({
    // 当前回合（L2，每回合变；绝不能放 L0）
    turnIndex: world.turnIndex,
    inGameDate: world.inGameDate,
    units: unitSummary,
    highValueNodeIds: nodeIds,
    // 上下文压缩摘要（若有，更稳定的前缀）
    contextSummary:
      contextSummary !== null
        ? { upToTurn: latestSummaryTurn, text: contextSummary }
        : null,
  })
}

// =============================================================================
// buildMessages：L0→L1→L2→L3 分层构造
// =============================================================================

/**
 * 参谋长对话人格 L0 system prompt（chief.ts 的 CHIEF_CHAT_SYSTEM_PROMPT 同款镜像）。
 *
 * **注意**：与上面 ROLE_SYSTEM_PROMPTS.chief（命令解析人格）不同——对话人格更口语化，
 * 职责是回答态势/问候/建议而非解析结构化命令。
 *
 * 此常量与 chief.ts 中的 CHIEF_CHAT_SYSTEM_PROMPT **必须保持文本一致**
 * （对话入口在 buildChatMessages 与 chatWithLlm 两侧都能构造 messages，
 * 故人格文本集中在此处由 chief.ts 转引，避免重复维护）。详见 chief.ts 注释。
 */
const CHIEF_CHAT_PERSONA_PROMPT = [
  '你是玩家的参谋长（Chief of Staff），一位经验丰富、沉稳睿智的军事副手。',
  '职责：与指挥官（玩家）进行自然语言对话——回答态势询问、提供战术建议、汇报战况、回应问候。',
  '口吻：称玩家为「长官」，语气专业、简洁、有条理，适当带入军事术语，但不过度冗长。',
  '原则：',
  '- 仅基于上下文提供的真实世界状态回答，绝不虚构不存在的单位/阵地/战况。',
  '- 给建议时要有依据（援引当前单位位置、敌方态势、地形），不空谈。',
  '- 不主动下达命令或执行动作；玩家要下命令需用明确指令词（移动/攻击/占领/固守）。',
  '- 回复控制在 2-5 句，适合终端对话气泡展示。',
  '- 你有上下文记忆：可援引对话历史中提到的单位/阵地/话题（如「刚才你问的杜奥蒙堡」）。',
  '直接输出自然语言回复，不要输出 JSON 或其他格式。',
].join('\n')

/**
 * 暴露参谋长对话人格文本供 chief.ts 复用（保证两侧 L0 字节一致，吃满缓存）。
 * @internal 仅供 chief.ts 内部 import，不对外作为公共协议。
 */
export function getChiefChatPersonaPrompt(): string {
  return CHIEF_CHAT_PERSONA_PROMPT
}

/** buildMessages 的角色名（重导出，避免与 AgentRole 冲突时清晰） */
export type { AgentRole as ContextBuilderRole }

/** buildMessages 的上下文输入 */
export interface BuildMessagesInput {
  /** 当前世界状态（提供 L1 战役数据 + L2 世界状态摘要） */
  worldState: WorldState
  /** L3 本条具体任务/指令文本 */
  task: string
  /**
   * 可选历史 messages（append-only 多轮对话）。
   * 放在 L2 之后、L3 之前——历史天然命中缓存（符合 DeepSeek 官方例一）。
   */
  history?: AgentMessage[]
}

/**
 * 按 L0-L3 缓存分层构造 OpenAI/DeepSeek 兼容的 messages 数组。
 *
 * 分层顺序（稳定→易变，最大化前缀缓存命中）：
 * 1. L0 system：角色人格 + 输出 schema 说明（**完全固定，禁注入易变内容**）。
 * 2. L1 system：战役数据（开局冻结）。
 * 3. L2 system：当前回合世界状态摘要 + 上下文压缩摘要（每回合变，同回合共享）。
 * 4. history（可选，append-only）。
 * 5. L3 user：本条具体任务（每请求变，回合号/时间戳只放这里）。
 *
 * @param role Agent 角色
 * @param input 上下文输入
 * @returns 分层 messages 数组
 */
export function buildMessages(
  role: AgentRole,
  input: BuildMessagesInput,
): AgentMessage[] {
  const messages: AgentMessage[] = []

  // L0：角色人格 + 输出 schema 说明（两条独立 system 消息，均完全固定）
  messages.push({ role: 'system', content: ROLE_SYSTEM_PROMPTS[role] })
  messages.push({ role: 'system', content: ROLE_SCHEMA_TEXT[role] })

  // L1：战役数据（开局冻结）
  messages.push({
    role: 'system',
    content: `战役数据（本局冻结）：\n${serializeCampaignData(input.worldState)}`,
  })

  // L2：当前回合世界状态摘要 + 上下文压缩摘要（每回合变，同回合共享）
  messages.push({
    role: 'system',
    content: `当前世界状态摘要（本回合）：\n${serializeWorldSummary(input.worldState)}`,
  })

  // 历史消息（append-only，多轮对话天然命中缓存）
  if (input.history && input.history.length > 0) {
    for (const msg of input.history) {
      messages.push(msg)
    }
  }

  // L3：本条具体任务（每请求变，回合号/时间戳只放这里）
  messages.push({ role: 'user', content: input.task })

  return messages
}

// =============================================================================
// buildChatMessages：参谋长多轮对话专用（含历史，区别 buildMessages 命令解析）
// =============================================================================
//
// 与 buildMessages 的区别：
// - L0 用 CHIEF_CHAT_PERSONA_PROMPT（对话人格，非命令解析人格）。
// - L1/L2 复用同一套战役数据/世界摘要序列化函数（缓存前缀与命令解析共享）。
// - history 是高层 DialogueTurn[]（player/chief），转 AgentMessage 后注入 L2 之后、L3 之前。
//   对话历史天然 append-only，每追加一轮只增长尾部，前缀稳定 → 缓存命中。
// - L3 是本轮玩家问话（自然语言，不要求 JSON）。
//
// 对话历史不破坏 L0/L1 缓存前缀（历史在 L2 之后），符合「DeepSeek 官方例一」缓存策略。

/**
 * 把高层 DialogueTurn[]（player/chief）映射为 LLM wire 格式 AgentMessage[]。
 *
 * - 'player' → 'user'（指挥官发言对应用户角色）。
 * - 'chief' → 'assistant'（参谋长上一轮回复，作为助手上下文）。
 * - 'system' 不出现在对话历史里（对话历史只有两个对话方）。
 *
 * 纯函数：仅做字段映射，不读时间/随机。
 *
 * @param history 高层对话历史
 * @returns LLM wire 格式 messages（可直接 append 到 messages 数组）
 */
export function dialogueTurnsToMessages(history: readonly DialogueTurn[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const turn of history) {
    if (turn.role === 'player') {
      out.push({ role: 'user', content: turn.text })
    } else {
      // chief → assistant
      out.push({ role: 'assistant', content: turn.text })
    }
  }
  return out
}

/** buildChatMessages 的上下文输入 */
export interface BuildChatMessagesInput {
  /** 当前世界状态（L1 战役数据 + L2 世界状态摘要来源） */
  worldState: WorldState
  /** 本轮玩家问话（L3，自然语言） */
  task: string
  /** 最近 N 轮对话历史（高层 DialogueTurn，转 wire 格式后注入 L2 之后） */
  history?: readonly DialogueTurn[]
}

/**
 * 按 L0-L3 缓存分层构造参谋长对话 messages（含多轮历史）。
 *
 * 分层顺序（稳定→易变，最大化前缀缓存命中）：
 * 1. L0 system：参谋长对话人格（**完全固定，禁注入易变内容**）。
 * 2. L1 system：战役数据（开局冻结）。
 * 3. L2 system：当前回合世界状态摘要 + 上下文压缩摘要（每回合变，同回合共享）。
 * 4. history（可选，DialogueTurn 转 AgentMessage，append-only，天然命中缓存）。
 * 5. L3 user：本轮玩家问话（每请求变，回合号/时间戳只放这里）。
 *
 * 与 {@link buildMessages} 的区别：L0 用对话人格而非命令解析人格，
 * history 类型是高层 DialogueTurn[]（玩家方/参谋方）而非裸 AgentMessage[]。
 *
 * @param input 对话上下文输入
 * @returns 分层 messages 数组（含历史）
 */
export function buildChatMessages(input: BuildChatMessagesInput): AgentMessage[] {
  const messages: AgentMessage[] = []

  // L0：参谋长对话人格（固定不变）
  messages.push({ role: 'system', content: CHIEF_CHAT_PERSONA_PROMPT })

  // L1：战役数据（开局冻结）
  messages.push({
    role: 'system',
    content: `战役数据（本局冻结）：\n${serializeCampaignData(input.worldState)}`,
  })

  // L2：当前回合世界状态摘要 + 上下文压缩摘要（每回合变，同回合共享）
  messages.push({
    role: 'system',
    content: `当前世界状态摘要（本回合）：\n${serializeWorldSummary(input.worldState)}`,
  })

  // 历史对话（append-only，多轮天然命中缓存）—— DialogueTurn → AgentMessage
  if (input.history && input.history.length > 0) {
    const historyMessages = dialogueTurnsToMessages(input.history)
    for (const msg of historyMessages) {
      messages.push(msg)
    }
  }

  // L3：本轮玩家问话（自然语言，回合号属 L3 安全，system prompt 不含回合号）
  messages.push({ role: 'user', content: input.task })

  return messages
}

// =============================================================================
// estimateCacheLayers：辅助 Inspector 展示分层
// =============================================================================

/**
 * 缓存分层估算（供 Agent Inspector 展示分层与命中率诊断）。
 *
 * 返回每层的 message index 范围与粗略字符数。
 * 纯函数：仅基于 messages 内容估算，不调 Tauri/tokenizer。
 *
 * 注意：字符数 ≠ token 数（中文一个字约 1-2 token），仅作诊断参考。
 */
export interface CacheLayerEstimate {
  /** L0 固定层（人格 + schema）：起止 message index（含） */
  l0: { startIndex: number; endIndex: number; charCount: number }
  /** L1 战役数据：起止 index */
  l1: { startIndex: number; endIndex: number; charCount: number }
  /** L2 世界状态摘要：起止 index */
  l2: { startIndex: number; endIndex: number; charCount: number }
  /** 历史层（若有）：起止 index */
  history?: { startIndex: number; endIndex: number; charCount: number }
  /** L3 任务层：起止 index */
  l3: { startIndex: number; endIndex: number; charCount: number }
}

/**
 * 估算 messages 的缓存分层结构。
 *
 * buildMessages 产出的 messages 顺序固定：
 * [0]=人格(L0) [1]=schema(L0) [2]=战役数据(L1) [3]=世界摘要(L2) [history...] [last]=任务(L3)
 *
 * 本函数按此固定结构解析（与 buildMessages 一一对应），用于 Inspector 诊断。
 * 若传入非 buildMessages 产出的 messages，结果可能不准确（仍尽力解析）。
 *
 * @param messages buildMessages 产出的 messages
 * @returns 分层估算
 */
export function estimateCacheLayers(
  messages: AgentMessage[],
): CacheLayerEstimate {
  const charCount = (start: number, end: number): number => {
    let sum = 0
    for (let i = start; i <= end && i < messages.length; i++) {
      sum += messages[i]?.content.length ?? 0
    }
    return sum
  }

  const last = messages.length - 1

  // 约定结构：L0=[0,1] L1=[2] L2=[3] history=[4..last-1] L3=[last]
  // 容错：messages 不足时按实际长度收缩
  const l0End = Math.min(1, last)
  const l1Start = Math.min(2, last)
  const l1End = l1Start
  const l2Start = Math.min(3, last)
  const l2End = l2Start

  const hasHistory = last > 4
  const historyStart = 4
  const historyEnd = hasHistory ? last - 1 : 3
  const l3Start = last
  const l3End = last

  const estimate: CacheLayerEstimate = {
    l0: { startIndex: 0, endIndex: l0End, charCount: charCount(0, l0End) },
    l1: {
      startIndex: l1Start,
      endIndex: l1End,
      charCount: charCount(l1Start, l1End),
    },
    l2: {
      startIndex: l2Start,
      endIndex: l2End,
      charCount: charCount(l2Start, l2End),
    },
    l3: {
      startIndex: l3Start,
      endIndex: l3End,
      charCount: charCount(l3Start, l3End),
    },
  }

  if (hasHistory) {
    estimate.history = {
      startIndex: historyStart,
      endIndex: historyEnd,
      charCount: charCount(historyStart, historyEnd),
    }
  }

  return estimate
}

// =============================================================================
// 向后兼容：保留旧 buildContext 桩签名（内部转调 buildMessages 语义）
// =============================================================================

/**
 * @deprecated 用 buildMessages 替代。保留以兼容旧 import。
 * 把 systemPrompt/worldSummary/instruction 组装成最小 AgentContext。
 */
export function buildContext(parts: {
  systemPrompt: string
  worldSummary: string
  instruction: string
  history?: AgentMessage[]
}): AgentContext {
  return {
    systemPrompt: parts.systemPrompt,
    worldSummary: parts.worldSummary,
    instruction: parts.instruction,
    history: parts.history ?? [],
  }
}

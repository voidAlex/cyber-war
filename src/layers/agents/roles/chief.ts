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
  DialogueTurn,
} from '@/types'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from './llm-role-base'
import { buildLlmOptions } from './llm-role-base'
import {
  buildChatMessages,
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
 * **chat 多轮上下文**：parseCommand 保持 stateless（一次性解析）；
 * chat 携带 history 参数（最近 N 轮），让参谋长有"记忆"——
 * 玩家可连贯对话（问候→态势→建议→下命令），参谋长能援引上文（如"刚才你问的杜奥蒙堡"）。
 *
 * 历史不破坏 L0/L1 缓存前缀（放 L2 之后，详见 context-builder.buildChatMessages）。
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
   * 与参谋长自然语言对话（询问态势/问候/闲聊，多轮上下文）。
   *
   * 与 parseCommand 互补：parseCommand 把命令解析为结构化候选；
   * chat 回复自然语言（参谋口吻，基于真实 world 状态，不伪造命令）。
   *
   * 调用方应先用 {@link classifyInput} 判断输入类别再决定调哪个方法。
   *
   * 多轮上下文：history 传最近 N 轮（玩家+参谋交替），参谋长能援引上文。
   * 历史注入 LLM 的 L2 之后、L3 之前（buildChatMessages），
   * 不破坏 L0/L1 缓存前缀。mock 实现简单拼接最近轮作上下文（或忽略）。
   *
   * **流式 onDelta（第 2 批打字机）**：可选回调，LLM 每产出一段文本片段时回调，
   * UI（store liveChat）据此逐字渲染气泡。仅 UI 副作用，**不影响 prompt 结构/缓存前缀**。
   * mock 实现一次性全量回调（模拟"瞬时完成"，不阻塞 UI 打字机逻辑路径）。
   *
   * @param input 玩家自然语言（如「你好 我们现在是什么状态」）
   * @param ctx 世界状态视图
   * @param history 最近 N 轮对话历史（player/chief），用作参谋长上下文记忆；可选
   * @param onDelta 可选：每个文本片段到达时回调（实时 partial，UI 打字机用）
   * @returns 对话回复文本（mock 模板 或 LLM 参谋人格回复）
   */
  chat(
    input: string,
    ctx: ChiefParseContext,
    history?: readonly DialogueTurn[],
    onDelta?: (partial: string) => void,
  ): Promise<ChiefChatResult>
}

/**
 * 意图关键词表（中文 + 英文别名，用于规则匹配）。
 * 顺序：更具体的意图在前（capture_node 优先于 move，避免「占领 C3」误判为 move）。
 *
 * Bug C 修复（2026-06）：'surrender'（投降/降）放在最前——确保玩家说"投降"3 遍
 * 也命中命令而非被 classifyInput 当 chat 处理。"投降"是最高优先级命令（一锤定音）。
 */
const INTENT_KEYWORDS: ReadonlyArray<{ intent: CommandIntent; words: readonly string[] }> = [
  // Bug C：投降最高优先级。词表覆盖"投降/降/缴械/认输/放弃抵抗/我们输了"等。
  // 注意"降"是单字，会与"降落/下降"等冲突——故仅"投降/缴械/认输/放弃抵抗/投降吧"等
  // 明确词命中；纯"降"字不放进关键词（避免误命中"降雨/降雪"等）。
  {
    intent: 'surrender',
    words: [
      '投降', '投降吧', '我们投降', '全军投降', '缴械', '缴械投降',
      '认输', '我们认输', '放弃抵抗', '放弃战斗', '不打了', '我们输了',
      'surrender', 'we surrender', 'give up', 'capitulate',
    ],
  },
  {
    intent: 'capture_node',
    words: ['占领', '夺取', '攻占', '夺占', '攻取', 'capture', 'seize', 'occupy'],
  },
  {
    intent: 'attack',
    words: ['攻击', '进攻', '打击', '突击', '交火', '歼击', 'attack', 'assault', 'engage', 'strike'],
  },
  {
    intent: 'recon',
    words: ['侦察', '侦查', '探查', '探测', '刺探', '窥探', 'recon', 'reconnaissance', 'scout', 'spy', 'spot', 'probe'],
  },
  // T1-A：构筑工事/战壕（比 hold 更具体——"挖战壕"不应归到 hold 的就地固守）。
  // 放在 hold 之前确保"构筑工事"命中 entrench 而非 hold。
  {
    intent: 'entrench',
    words: [
      '构筑', '挖战壕', '战壕', '设防', '加固', '工事', '壕沟',
      'entrench', 'dig in', 'dig_in', 'fortify', 'trench',
    ],
  },
  // T2 第 2 批：电子战（比 move 更具体——"电子支援"不应归到 move 的"支援"）。
  // 放在 move 之前确保"电子干扰/电子支援"命中 ew_* 而非 move。
  {
    intent: 'ew_jam',
    words: [
      '电子干扰', '干扰雷达', '压制雷达', '电磁压制', '干扰',
      'jam', 'ew jam', 'ew_jam',
    ],
  },
  {
    intent: 'ew_support',
    words: [
      '电子支援', '电子战支援', '增强侦察', '电磁支援',
      'ew support', 'ew_support',
    ],
  },
  // T2 第 4 批：特殊作战（比 move/attack 更具体，放前面避免"空降"误判）。
  {
    intent: 'sabotage',
    words: [
      '破坏', '爆破', '炸毁', '摧毁', ' sabot', 'sabotage',
    ],
  },
  {
    intent: 'paradrop',
    words: [
      '空降', '伞降', '空投', '伞兵',
      'paradrop', 'airdrop', 'airborne',
    ],
  },
  {
    intent: 'commando_raid',
    words: [
      '斩首', '特种作战', '偷袭', '突袭', '特种突袭', '突击队',
      'commando', 'raid', 'spec ops', 'special ops',
    ],
  },
  // T3-B：地形改造（架桥/炸桥/修路）。比 move 更具体——"架桥"不应归到 move。
  // 放在 move 之前确保命中 build_*/destroy_*。
  {
    intent: 'build_bridge',
    words: [
      '架桥', '造桥', '建桥', '搭桥', '构筑浮桥', '架设浮桥',
      'build bridge', 'build_bridge', 'construct bridge',
    ],
  },
  {
    intent: 'destroy_bridge',
    words: [
      '炸桥', '毁桥', '拆桥', '爆破桥梁', '摧毁桥梁',
      'destroy bridge', 'destroy_bridge', 'demolish bridge',
    ],
  },
  {
    intent: 'build_road',
    words: [
      '修路', '筑路', '建路', '铺路', '构筑公路',
      'build road', 'build_road', 'construct road', 'pave road',
    ],
  },
  // T2 第 3 批：宣传/舆论（放 move 之前避免"宣传攻势"被误判）。
  {
    intent: 'propaganda',
    words: [
      '宣传', '舆论', '舆论战', '媒体', '宣传攻势',
      'propaganda', 'media campaign',
    ],
  },
  {
    intent: 'move',
    // 第 3 批：增援/支援语义等同于「移动到目标位置」——解析阶段直接归一为 move，
    // 不新增 CommandIntent 联合类型 / 不动 physics worker（worker normalizeIntent 已把
    // move 类别名归到 move 物理结算）。增援/支援到某节点=移动到该节点格。
    words: [
      '移动', '机动', '前进', '推进', '行军', '开进', '转移到', '前往',
      '增援', '支援到', '支援', '驰援',
      'move', 'march', 'advance', 'go to',
      'reinforce', 'support', 'relief',
    ],
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
 * 疑问/征询标志词（命中则即便含意图词也判 chat）。
 *
 * 用于 classifyInput 区分"命令"与"询问/征询"：
 * - "步兵需要移动吗"含"吗"→ 询问（chat）
 * - "我们要不要攻击"含"要不要"→ 征询（chat）
 * - "怎么样需要移动"含"怎么样"→ 询问（chat）
 * - "第一装甲师移动到 C3"无疑问标志 → 命令（command）
 *
 * 注意：纯命令不含疑问词；疑问句才含。故以此反推。
 */
const QUESTION_MARKERS: readonly string[] = [
  '吗', '呢', '？', '?',
  '要不要', '需不需要', '是不是', '能不能', '可不可以',
  '怎么样', '如何', '好不好', '行不行',
]

/** 输入是否含疑问/征询标志（用于 classifyInput 反推询问态） */
function hasQuestionMarker(lower: string): boolean {
  for (const m of QUESTION_MARKERS) {
    if (lower.includes(m)) return true
  }
  return false
}

/**
 * 纯函数：判断玩家输入是「命令」还是「对话/询问」。
 *
 * 路由规则（先用规则省成本，LLM 判断更准但多一次调用）：
 * 1. 输入含任何命令意图关键词（移动/攻击/占领/固守等）：
 *    - 同时含疑问/征询标志（吗/呢/？/要不要/怎么样等）→ `'chat'`（询问而非命令）。
 *    - 否则（命令陈述句）→ `'command'`。
 * 2. 无命令意图词 → `'chat'`（问候/询问/闲聊/无意义输入）。
 *
 * 修复问题（重写计划 B）："怎么样需要移动吗"含"移动"+"吗"+"怎么样"→ chat。
 * "第一装甲师移动到 C3"含"移动"无疑问标志 → command。
 * "占领杜奥蒙堡"含"占领"无疑问标志 → command。
 * "步兵需要移动吗"含"吗"→ chat。
 *
 * 这是基于"疑问句式 ≠ 命令"的反推——比"必须有单位+目标"更宽松，
 * 因为 capture_node 的节点名、attack 的敌方单位名无法穷举预判，
 * 强制要求"单位+目标齐全"会把"占领杜奥蒙堡"误判为 chat。
 *
 * 注意：与 matchIntent 共用 INTENT_KEYWORDS 表，保证一致。
 *
 * @param input 玩家原始输入
 * @returns 'command' | 'chat'
 */
export function classifyInput(input: string): ChiefInputKind {
  const lower = input.trim().toLowerCase()
  if (lower.length === 0) return 'chat'
  // 先找意图词（不命中直接 chat）
  const intent = matchIntent(lower)
  if (intent === null) return 'chat'

  // 意图词命中后，疑问句式 → chat（询问/征询，非命令陈述）
  if (hasQuestionMarker(lower)) return 'chat'

  // 命令陈述句 → command
  return 'command'
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
    async chat(input, ctx, history, onDelta) {
      return chatMock(input, ctx, history, onDelta)
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
    async chat(input, ctx, history, onDelta) {
      try {
        return await chatWithLlm(input, ctx, llmService, config, history, onDelta)
      } catch (err) {
        // LLM 失败：回退 mock 模板回复（绝不伪造命令，绝不卡死对话）。
        // eslint-disable-next-line no-console
        console.error('[chief] LLM 对话失败，回退 mock 模板回复:', err)
        if (isLlmCallError(err)) {
          return chatMock(input, ctx, history)
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

    // Bug1 修复：move 候选若 LLM 漏给 targetCoord，用真实数据兜底补全（绝不伪造）。
    // LLM 常解析了单位/节点名但漏填坐标，导致 envelope payload.target 为空 →
    // physics.worker resolveMoveOrder 报「缺少目标坐标」blockade，游戏完全不可移动。
    // 兜底顺序：targetUnitId 所在单位 coord（追击/靠拢）→ nodeId 节点 cellId 坐标。
    // 补全后的 targetCoord 仍走下方 isInBounds 校验，越界则剔除（不破坏既有约束）。
    let validated: ChiefCandidateCommand = cand
    if (validated.intent === 'move' && !validated.targetCoord) {
      const fallback = fallbackMoveCoord(validated, ctx.world)
      if (fallback !== null) {
        validated = { ...validated, targetCoord: fallback }
      }
    }

    // move/capture 的 targetCoord 必须在范围内
    if (validated.targetCoord) {
      if (!isInBounds(validated.targetCoord, ctx.world.map.cols, ctx.world.map.rows)) continue
    }
    validCandidates.push(validated)
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
//
// 对话人格 L0 文本统一由 context-builder.ts 维护（CHIEF_CHAT_PERSONA_PROMPT），
// 经 getChiefChatPersonaPrompt() 取得，避免 chief.ts 本地常量与 context-builder
// 各维护一份造成漂移（两侧 L0 必须字节一致才能稳定吃缓存）。

/**
 * 真 LLM 参谋长对话实现（多轮上下文）。
 *
 * messages 构造走 context-builder.buildChatMessages：
 * - L0 用 CHIEF_CHAT_PERSONA_PROMPT（对话人格，固定）。
 * - L1 战役数据（开局冻结）。
 * - L2 世界状态摘要（每回合变，同回合共享）。
 * - history（DialogueTurn[] → AgentMessage[]，append-only，天然命中缓存）。
 * - L3 本轮玩家问话（含回合号，回合号属 L3 安全）。
 *
 * 用 llmService.streamTextWithDeltas（非结构化，带 onDelta 增量回调）拿纯文本回复，
 * 边出边显示（第 2 批打字机效果，TTFT<200ms 目标）。
 * 失败抛 LlmCallError，由 createLlmChiefRole 上层回退 mock 模板。
 *
 * @param history 最近 N 轮对话历史（player/chief），注入 L2 之后让参谋有记忆
 * @param onDelta 可选：每个文本片段到达时回调（实时 partial，UI 打字机用）。
 *   仅 UI 副作用，不影响 prompt 结构/缓存前缀（onDelta 不改 messages）。
 * @throws LlmCallError（四分类/degraded）由上层回退 mock
 */
async function chatWithLlm(
  input: string,
  ctx: ChiefParseContext,
  llmService: LlmService,
  config: LlmCallConfig,
  history?: readonly DialogueTurn[],
  onDelta?: (partial: string) => void,
): Promise<ChiefChatResult> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    // 空输入直接走 mock（不浪费 LLM 调用）
    return chatMock(input, ctx, history, onDelta)
  }

  // buildChatMessages 负责 L0-L3 分层 + history 转换（集中维护，避免重复）
  const messages = buildChatMessages({
    worldState: ctx.world,
    // L3 任务文本：回合号属 L3 安全（system prompt 不含回合号）
    task: `（当前第 ${ctx.world.turnIndex} 回合，${ctx.world.inGameDate}）\n指挥官说："${trimmed}"\n请以参谋长口吻回复。`,
    history: history,
  })

  // streamTextWithDeltas：消费 gateway async iterator，onDelta 在每个 text 片段到达时回调。
  // 真流式（默认 gateway）路径才触发 delta；注入 stream（测试 mock）时无 delta（一次性）。
  const result = await llmService.streamTextWithDeltas(
    {
      provider: config.provider,
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      // 对话用稍高温度增加自然度（命令解析用默认）；若 config 已设 extraParams 则合并
      extraParams: { temperature: 0.7, ...(config.extraParams ?? {}) },
    },
    onDelta,
  )

  const text = result.text.trim()
  if (text.length === 0) {
    // LLM 返回空：回退 mock（不伪造，用模板）
    return chatMock(input, ctx, history, onDelta)
  }
  return { text, source: 'llm' }
}

/**
 * 把历史最近一轮玩家发言文本取出（用于 mock 上下文记忆提示）。
 * 没有历史返回 null。
 */
function lastPlayerTurn(history: readonly DialogueTurn[] | undefined): string | null {
  if (!history || history.length === 0) return null
  // 从尾向前找最近一条 player 发言
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'player') return history[i].text
  }
  return null
}

/**
 * mock 参谋长对话（纯函数模板，离线/降级/LLM 失败时兜底）。
 *
 * 基于 world 真实状态生成回复，绝不伪造命令或编造不存在的态势。
 * 多轮上下文：history 简单用作"上文记忆提示"——若上轮玩家问过特定单位/节点，
 * 本轮可回应"刚才你提到的 XX"。
 *
 * 几个分支：
 * - 问候 → 回礼 + 简报当前态势（含上文记忆提示）。
 * - 问状态/战况 → 汇报回合、阵地、关键单位位置。
 * - 其他（建议/闲聊）→ 通用参谋口吻回复 + 引导下命令。
 *
 * @param history 最近 N 轮对话历史（player/chief），用于上下文记忆提示
 */
function chatMock(
  input: string,
  ctx: ChiefParseContext,
  history?: readonly DialogueTurn[],
  onDelta?: (partial: string) => void,
): ChiefChatResult {
  const result = chatMockImpl(input, ctx, history)
  // mock 模拟"瞬时完成"：一次性全量回调（与 LLM 真流式的多段 delta 不同，
  // 但让 UI 打字机逻辑路径统一：store liveChat 始终走 set→append→clear 三态）。
  if (onDelta && result.text.length > 0) {
    onDelta(result.text)
  }
  return result
}

/**
 * mock 参谋长对话实现本体（纯函数模板，离线/降级/LLM 失败时兜底）。
 *
 * 由 {@link chatMock} 包装后对外暴露（chatMock 额外负责 onDelta 一次性回调）。
 */
function chatMockImpl(
  input: string,
  ctx: ChiefParseContext,
  history?: readonly DialogueTurn[],
): ChiefChatResult {
  const world = ctx.world
  const playerUnits = world.units.filter((u) => u.factionId === ctx.playerFactionId)
  const enemyUnits = world.units.filter((u) => u.factionId !== ctx.playerFactionId)
  const turn = world.turnIndex
  const date = world.inGameDate

  // 节点控制摘要（哪些节点名）
  const nodeName = (n: { name: string }): string => n.name

  // 上文记忆提示：若上轮玩家问过某个高价值节点，本轮简报可点一句"刚才你问的 XX"
  // 节点名可能含英文括注（如「杜奥蒙堡 (Fort Douaumont)」），玩家输入通常只写中文
  // （「杜奥蒙堡」），故用「节点名中文片段是否被 prevPlayer 包含」做匹配（双向容错）。
  const prevPlayer = lastPlayerTurn(history)
  let memoryHint = ''
  if (prevPlayer !== null && world.map.highValueNodes.length > 0) {
    const mentioned = world.map.highValueNodes.find((n) => {
      // 直接全名包含（节点名是 prevPlayer 子串）
      if (prevPlayer.includes(n.name)) return true
      // 取节点名的中文片段（去括号英文），看是否被 prevPlayer 包含
      // 如「杜奥蒙堡 (Fort Douaumont)」→「杜奥蒙堡」
      const cnPart = n.name.replace(/\s*[(（].*?[)）].*/g, '').trim()
      return cnPart.length > 0 && prevPlayer.includes(cnPart)
    })
    if (mentioned !== undefined) {
      // 提示用中文片段（去英文括注），更自然
      const cnName = mentioned.name.replace(/\s*[(（].*?[)）].*/g, '').trim() || mentioned.name
      memoryHint = `（接你刚才提到的${cnName}）`
    }
  }

  if (hasChatKeyword(input)) {
    // 含问候/询问态势等对话词
    if (/你好|您好|hi|hello|嗨|早|晚上好|下午好|早上好/i.test(input)) {
      return {
        source: 'mock',
        text: `长官，参谋长报到。${memoryHint}当前第 ${turn} 回合（${date}），我方尚有 ${playerUnits.length} 个建制可调动，当面之敌约 ${enemyUnits.length} 个建制。${world.map.highValueNodes.length > 0 ? `关键目标：${world.map.highValueNodes.slice(0, 3).map(nodeName).join('、')}。` : ''}请下令。`,
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
        text: `长官，${memoryHint}第 ${turn} 回合态势：我方${playerUnits.length > 0 ? `主力 ${unitBrief}` : '暂无可调单位'}。当面敌军约 ${enemyUnits.length} 个建制。${world.map.highValueNodes.length > 0 ? `争夺焦点：${world.map.highValueNodes.slice(0, 3).map(nodeName).join('、')}。` : ''}`,
      }
    }
    if (/建议|怎么办|怎么看|你觉得|你认为|有什么|能做/.test(input)) {
      return {
        source: 'mock',
        text: `长官，${memoryHint}依参谋部判断：优先确保关键节点防御，再图反击。若要推进，可命装甲/步兵向目标格机动，炮兵提供火力支援。具体请下达命令（如「${UNIT_TYPE_CN[playerUnits[0]?.type ?? 'infantry'] ?? '步兵'}移动到 C3」）。`,
      }
    }
    // 谢谢/再见等其他对话词
    return {
      source: 'mock',
      text: `长官不必客气，${memoryHint}参谋部随时待命。如需下令请直说，例如「某单位移动到某坐标」。`,
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
  //    recon/surrender 意图允许不指明单位：
  //    - recon：玩家常说「侦察杜奥蒙」而省略侦察单位，case 'recon' 内自动选首个 recon 类型兜底。
  //    - surrender（Bug C）：全军投降是全局命令，不需要单位匹配——直接进 case 'surrender'。
  //    其他意图（move/attack/capture/hold）必须显式匹配单位，否则 clarify。
  const matchedUnits = matchUnits(trimmed, playerUnits)
  if (matchedUnits.length === 0 && intent !== 'recon' && intent !== 'surrender') {
    return clarify(
      input,
      '未匹配到任何己方单位，请指明具体单位',
      playerUnits.slice(0, 5).map((u) => `可用单位：${describeUnit(u)}`),
    )
  }

  // 3. 按意图提取并校验目标
  switch (intent) {
    case 'surrender': {
      // Bug C：全军投降。全局命令，不需要单位/坐标/节点。
      // 直接产出 ParsedCommand{ intent:'surrender', summary:'全军投降' }。
      // 物理层（resolveSurrenderOrder）会把玩家方所有单位 strength=0 + status='surrendered'，
      // 产出 'surrender' 事件；编排器检测到后跳过导演部 adjudicate，直接判对方胜利。
      // 确定性：无随机数。
      const factionName = ctx.world.factions.find((f) => f.id === ctx.playerFactionId)?.name ?? ctx.playerFactionId
      return {
        kind: 'parsed',
        intent: 'surrender',
        targetUnitIds: [],
        summary: `${factionName} 全军投降，放下武器`,
        confidence: 1.0,
      }
    }

    case 'move': {
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      // Bug1 修复：无坐标时用真实数据兜底（节点名 → 节点坐标；敌方单位 → 其坐标）。
      // 绝不伪造：兜底坐标全部来自 world 真实单位/节点。
      if (coord === null) {
        // 1) 高价值节点名（如「移动到杜奥蒙堡」→ 节点 cellId 坐标）
        const node = matchNode(trimmed, ctx.world.map.highValueNodes)
        if (node !== null) {
          const nodeCoord = parseCellId(node.cellId)
          if (nodeCoord !== null) {
            const summary =
              matchedUnits.map((u) => u.id).join('、') +
              ` 移动到 ${nodeNameCn(node.name)} (${nodeCoord.col},${nodeCoord.row})`
            return parsed('move', matchedUnits.map((u) => u.id), {
              targetCoord: nodeCoord,
              nodeId: node.id,
              summary,
            })
          }
        }
        // 2) 目标敌方单位（如「移动到敌方步兵师旁」→ 其 coord，靠拢语义）
        const enemyUnits = ctx.world.units.filter((u) => u.factionId !== ctx.playerFactionId)
        const targetEnemy = matchUnits(trimmed, enemyUnits)[0]
        if (targetEnemy !== undefined) {
          const ec = { ...targetEnemy.coord }
          const summary =
            matchedUnits.map((u) => u.id).join('、') +
            ` 靠拢 ${targetEnemy.id} (${ec.col},${ec.row})`
          return parsed('move', matchedUnits.map((u) => u.id), {
            targetCoord: ec,
            targetUnitId: targetEnemy.id,
            summary,
          })
        }
        return clarify(
          input,
          '未解析到合法目标坐标，请指明目标格（如 C3）或节点名（如 杜奥蒙堡）',
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

    case 'entrench': {
      // T1-A：构筑工事。单位就地不动，entrenchment +1 + cell.fortificationLevel 提升。
      // 无需目标坐标/节点（单位在原地构筑）。
      const summary =
        matchedUnits.map((u) => u.id).join('、') + ' 构筑工事（战壕等级 +1）'
      return parsed('entrench', matchedUnits.map((u) => u.id), { summary })
    }

    case 'recon': {
      // 侦察执行单位：玩家未指明时自动选首个 recon 类型单位（专业侦察），否则取首个单位。
      // 绝不伪造——候选仅来自真实 playerUnits。
      let reconUnits = matchedUnits
      if (reconUnits.length === 0) {
        const professional = playerUnits.filter((u) => u.type === 'recon')
        reconUnits = professional.length > 0 ? [professional[0]] : [playerUnits[0]]
      }
      // 侦察目标解析顺序：坐标（C3）→ 高价值节点名（杜奥蒙堡→节点 cell）→ 敌方单位（其 cell）
      // 1) 坐标（字母+数字 或 数字对）
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      let targetCoord: GridCoord | null = coord
      let targetUnitId: string | undefined
      if (targetCoord === null) {
        // 2) 高价值节点名（如「侦察杜奥蒙」→ 节点 cell 坐标）
        const node = matchNode(trimmed, ctx.world.map.highValueNodes)
        if (node !== null) {
          targetCoord = parseCellId(node.cellId)
        }
      }
      if (targetCoord === null) {
        // 3) 目标敌方单位（如「侦察敌方步兵」→ 其所在 cell）
        const enemyUnits = ctx.world.units.filter((u) => u.factionId !== ctx.playerFactionId)
        const targetEnemy = matchUnits(trimmed, enemyUnits)[0]
        if (targetEnemy !== undefined) {
          targetCoord = { ...targetEnemy.coord }
          targetUnitId = targetEnemy.id
        }
      }
      if (targetCoord === null) {
        return clarify(
          input,
          '未解析到侦察目标，请指明目标坐标（如 C3）、节点名（如 杜奥蒙堡）或敌方单位',
          [
            coordFormatHint(ctx.world.map.cols, ctx.world.map.rows),
            ...(ctx.world.map.highValueNodes.length > 0
              ? [`可侦察节点：${ctx.world.map.highValueNodes.slice(0, 3).map((n) => n.name).join('、')}`]
              : []),
          ],
        )
      }
      const targetDesc = targetUnitId ?? `(${targetCoord.col},${targetCoord.row})`
      const summary = reconUnits.map((u) => u.id).join('、') + ` 侦察 ${targetDesc}`
      return parsed('recon', reconUnits.map((u) => u.id), {
        targetCoord,
        targetUnitId,
        summary,
      })
    }

    case 'ew_jam':
    case 'ew_support': {
      // T2 第 2 批：电子战。执行单位优先取 EW 单位（type ew 或 ewCapability 存在），
      // 玩家未指明时自动选首个 EW 单位兜底。目标坐标必填（干扰/支援区域）。
      let ewUnits = matchedUnits
      if (ewUnits.length === 0) {
        const ew = playerUnits.filter((u) => u.type === 'ew' || u.ewCapability)
        if (ew.length === 0) {
          return clarify(
            input,
            '未匹配到具备电子战能力的单位（需 type ew 或挂载 EW 装备）',
            playerUnits.slice(0, 5).map((u) => `可用单位：${describeUnit(u)}`),
          )
        }
        ewUnits = [ew[0]]
      }
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      let targetCoord: GridCoord | null = coord
      if (targetCoord === null) {
        // 节点名 / 敌方单位兜底坐标
        const node = matchNode(trimmed, ctx.world.map.highValueNodes)
        if (node !== null) targetCoord = parseCellId(node.cellId)
      }
      if (targetCoord === null) {
        const enemyUnits = ctx.world.units.filter((u) => u.factionId !== ctx.playerFactionId)
        const targetEnemy = matchUnits(trimmed, enemyUnits)[0]
        if (targetEnemy !== undefined) targetCoord = { ...targetEnemy.coord }
      }
      if (targetCoord === null) {
        return clarify(
          input,
          '未解析到电子战目标坐标，请指明目标格（如 C3）或敌方单位',
          [coordFormatHint(ctx.world.map.cols, ctx.world.map.rows)],
        )
      }
      const verb = intent === 'ew_jam' ? '电子干扰' : '电子支援'
      const summary =
        ewUnits.map((u) => u.id).join('、') + ` 对 (${targetCoord.col},${targetCoord.row}) 实施${verb}`
      return parsed(intent, ewUnits.map((u) => u.id), { targetCoord, summary })
    }

    case 'propaganda': {
      // T2 第 3 批：宣传。无 targetFaction 时为对内宣传（己方 morale+3）。
      // 单位可选（宣传可不绑定具体单位）；targetFaction 解析从输入匹配阵营名/id。
      const allFactions = ctx.world.factions.filter((f) => f.id !== ctx.playerFactionId)
      const targetFaction = allFactions.find((f) => {
        const lower = trimmed.toLowerCase()
        return (
          lower.includes(f.id.toLowerCase()) ||
          (f.name.length > 0 && lower.includes(f.name.toLowerCase()))
        )
      })
      const summary = targetFaction
        ? `对 ${targetFaction.name} 发动宣传攻势（publicWill +5）`
        : `${ctx.playerFactionId} 对内宣传（全军 morale +3）`
      const unitIds = matchedUnits.length > 0 ? matchedUnits.map((u) => u.id) : []
      const extra: { summary: string; targetUnitId?: string } = { summary }
      if (targetFaction) extra.targetUnitId = targetFaction.id
      return parsed('propaganda', unitIds, extra)
    }

    case 'sabotage':
    case 'commando_raid': {
      // T2 第 4 批：破坏/斩首突袭。执行单位优先取特种单位（recon/infantry+special）。
      let opUnits = matchedUnits
      if (opUnits.length === 0) {
        const special = playerUnits.filter((u) => {
          if (u.type !== 'recon' && u.type !== 'infantry') return false
          if (u.ewCapability) return true
          return (
            !!u.equipment &&
            u.equipment.some((s) => {
              const t = s.type.toLowerCase()
              return t.includes('special') || t.includes('laser') || t.includes('designator')
            })
          )
        })
        if (special.length === 0) {
          return clarify(
            input,
            '未匹配到具备特种作战能力的单位（需 recon/infantry + special 装备）',
            playerUnits.slice(0, 5).map((u) => `可用单位：${describeUnit(u)}`),
          )
        }
        opUnits = [special[0]]
      }
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      let targetCoord: GridCoord | null = coord
      if (targetCoord === null) {
        const node = matchNode(trimmed, ctx.world.map.highValueNodes)
        if (node !== null) targetCoord = parseCellId(node.cellId)
      }
      if (targetCoord === null) {
        const enemyUnits = ctx.world.units.filter((u) => u.factionId !== ctx.playerFactionId)
        const targetEnemy = matchUnits(trimmed, enemyUnits)[0]
        if (targetEnemy !== undefined) targetCoord = { ...targetEnemy.coord }
      }
      if (targetCoord === null) {
        return clarify(
          input,
          '未解析到特种作战目标，请指明目标坐标（如 C3）、节点名或敌方单位',
          [coordFormatHint(ctx.world.map.cols, ctx.world.map.rows)],
        )
      }
      const verb = intent === 'sabotage' ? '破坏' : '斩首突袭'
      const summary =
        opUnits.map((u) => u.id).join('、') + ` 对 (${targetCoord.col},${targetCoord.row}) 实施${verb}`
      return parsed(intent, opUnits.map((u) => u.id), { targetCoord, summary })
    }

    case 'paradrop': {
      // T2 第 4 批：空降。执行单位需 type air。
      let airUnits = matchedUnits
      if (airUnits.length === 0) {
        const air = playerUnits.filter((u) => u.type === 'air')
        if (air.length === 0) {
          return clarify(
            input,
            '未匹配到空中单位（需 type air 才能空降）',
            playerUnits.slice(0, 5).map((u) => `可用单位：${describeUnit(u)}`),
          )
        }
        airUnits = [air[0]]
      }
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      let targetCoord: GridCoord | null = coord
      if (targetCoord === null) {
        const node = matchNode(trimmed, ctx.world.map.highValueNodes)
        if (node !== null) targetCoord = parseCellId(node.cellId)
      }
      if (targetCoord === null) {
        return clarify(
          input,
          '未解析到空降目标坐标，请指明目标格（如 C3）或节点名',
          [coordFormatHint(ctx.world.map.cols, ctx.world.map.rows)],
        )
      }
      const summary =
        airUnits.map((u) => u.id).join('、') + ` 空降至 (${targetCoord.col},${targetCoord.row})`
      return parsed('paradrop', airUnits.map((u) => u.id), { targetCoord, summary })
    }

    case 'build_bridge':
    case 'destroy_bridge':
    case 'build_road': {
      // T3-B：地形改造。build_bridge/build_road 需工程单位（type support 或 engineer 装备）；
      // destroy_bridge 任何单位可执行（爆破）。目标坐标必填。
      const isDestroy = intent === 'destroy_bridge'
      let engineerUnits = matchedUnits
      if (engineerUnits.length === 0) {
        if (isDestroy) {
          // 炸桥：任何玩家单位可执行（取首个）
          engineerUnits = playerUnits.length > 0 ? [playerUnits[0]] : []
        } else {
          // 架桥/修路：需工程单位（type support 或装备含 engineer/pontoon/bridge/dozer/road）
          const engineers = playerUnits.filter((u) => {
            if (u.type === 'support') return true
            const slots = u.equipment
            if (!slots) return false
            return slots.some((s) => {
              const t = s.type.toLowerCase()
              return (
                t.includes('engineer') ||
                t.includes('pontoon') ||
                t.includes('bridge') ||
                t.includes('dozer') ||
                t.includes('road')
              )
            })
          })
          if (engineers.length === 0) {
            return clarify(
              input,
              '未匹配到具备工程能力的单位（需 type support 或 engineer 装备）',
              playerUnits.slice(0, 5).map((u) => `可用单位：${describeUnit(u)}`),
            )
          }
          engineerUnits = [engineers[0]]
        }
      }
      const coord = matchCoord(trimmed, ctx.world.map.cols, ctx.world.map.rows)
      let targetCoord: GridCoord | null = coord
      if (targetCoord === null) {
        const node = matchNode(trimmed, ctx.world.map.highValueNodes)
        if (node !== null) targetCoord = parseCellId(node.cellId)
      }
      if (targetCoord === null) {
        return clarify(
          input,
          `未解析到${intent === 'build_bridge' ? '架桥' : intent === 'destroy_bridge' ? '炸桥' : '修路'}目标坐标，请指明目标格（如 C3）`,
          [coordFormatHint(ctx.world.map.cols, ctx.world.map.rows)],
        )
      }
      const verb =
        intent === 'build_bridge'
          ? '架桥'
          : intent === 'destroy_bridge'
            ? '炸桥'
            : '修路'
      const summary =
        engineerUnits.map((u) => u.id).join('、') +
        ` 对 (${targetCoord.col},${targetCoord.row}) 实施${verb}`
      return parsed(intent, engineerUnits.map((u) => u.id), { targetCoord, summary })
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
 * 从输入中提取所有数字 token（用于「第N师」「N师」「unit-37」「第37步兵」等
 * 自然语言的数字兜底匹配）。
 *
 * 例如「第37师 移动」→ ['37']；「fr-infantry-37」→ ['37']。
 * 仅返回纯数字字符串（去「第」「师」等中文/连字符前缀）。
 */
function extractNumberTokens(text: string): string[] {
  const tokens = new Set<string>()
  // 「第N师」「第N装甲」等中文格式：第 + 数字 + 类型词
  for (const m of text.matchAll(/第\s*(\d+)/g)) {
    if (m[1] !== undefined) tokens.add(m[1])
  }
  // 「N师」「N装甲」（无「第」前缀的纯数字+类型）
  for (const m of text.matchAll(/(\d+)\s*师/g)) {
    if (m[1] !== undefined) tokens.add(m[1])
  }
  // 「unit-37」「fr-infantry-37」等连字符分隔的纯数字段
  for (const m of text.matchAll(/[-_\s](\d+)\b/g)) {
    if (m[1] !== undefined) tokens.add(m[1])
  }
  return Array.from(tokens)
}

/**
 * 单位 id 是否包含给定数字 token（作为独立段，避免「unit-1」误匹配数字「11」）。
 *
 * 匹配规则：把 unitId 按非字母数字拆段，若任一段严格等于 numToken 则命中。
 * 例如 unitId='fr-infantry-37' 段含 '37' → 命中 '37'；
 *      unitId='37th-armor' 段含 '37' → 命中 '37'；
 *      unitId='infantry-1' 段为 ['infantry','1'] → 不命中 '37'（避免「1」≠「37」）。
 */
function unitIdContainsNumber(unitId: string, numToken: string): boolean {
  if (numToken.length === 0) return false
  const segments = unitId.toLowerCase().split(/[^a-z0-9]+/).filter((s) => s.length > 0)
  return segments.includes(numToken.toLowerCase())
}

/**
 * 匹配单位：按单位 id / type 中文名 / 关键词片段 / 数字 token 匹配。
 * 返回所有命中的单位（玩家可下指令给多个单位）。
 *
 * 匹配顺序（任一命中即纳入，去重）：
 * 1. 单位 id 直接 includes（如输入含 `first-armor`）。
 * 2. 单位类型中文名 includes（如「装甲」「步兵」）。
 * 3. 单位类型英文名 includes（如 `infantry`）。
 * 4. 第 3 批新增：数字 token 兜底——输入含「第37师」「37师」「unit-37」等数字，
 *    单位 id 含该数字（作为独立段，见 {@link unitIdContainsNumber}）则命中。
 *    这样「第37师」可匹配 id 含「37」段的真实单位（如 `fr-infantry-37`）。
 *
 * 禁止伪造：仅在传入的 units 中匹配，不虚构 id。
 */
function matchUnits(text: string, units: readonly Unit[]): Unit[] {
  const lower = text.toLowerCase()
  const matched: Unit[] = []
  // 预提取数字 token（仅在有中文「师」/「第」或连字符数字时才有，避免无谓扫描）
  const numTokens = extractNumberTokens(text)
  for (const u of units) {
    let hit = false
    // 1) 单位 id 直接包含
    if (!hit && u.id.length > 0 && lower.includes(u.id.toLowerCase())) {
      hit = true
    }
    // 2) 单位类型中文名
    if (!hit) {
      const typeName = UNIT_TYPE_CN[u.type]
      if (typeName !== undefined && lower.includes(typeName)) hit = true
    }
    // 3) 单位类型英文名
    if (!hit && lower.includes(u.type)) {
      hit = true
    }
    // 4) 第 3 批：数字 token 兜底（「第37师」→ id 含 '37' 段）
    if (!hit && numTokens.length > 0) {
      for (const tok of numTokens) {
        if (unitIdContainsNumber(u.id, tok)) {
          hit = true
          break
        }
      }
    }
    if (hit) matched.push(u)
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
  // 第 5 批：陆海空导弹四域
  air: '空军',
  naval: '海军',
  missile: '导弹',
  // T2 第 2 批：电子战
  ew: '电子战',
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
 *
 * 第 3 批：复用 {@link matchNodeByName} 公用匹配逻辑。本函数为旧名兼容包装
 * （签名/返回值不变），供 chief.ts 内 capture_node / recon 等分支调用。
 */
function matchNode(
  text: string,
  nodes: ReadonlyArray<{ id: string; name: string; cellId: string }>,
): { id: string; name: string; cellId: string } | null {
  return matchNodeByName(text, nodes)
}

/**
 * 公用：按节点名/id 在节点列表中匹配（第 3 批提取，供 parseCommandMock 各分支复用）。
 *
 * 匹配优先级（任一命中即返回该节点）：
 * 1. 全名直接 includes（如输入含完整「杜奥蒙堡 (Fort Douaumont)」）。
 * 2. 中文片段双向 includes（容错「英文括注」）：
 *    节点名常含英文括注（如「杜奥蒙堡 (Fort Douaumont)」），但玩家/LLM 输入
 *    通常只写中文片段（「杜奥蒙堡」），反之亦然。取节点名去括号后的中文片段
 *    （{@link nodeNameCn}），做双向 includes 容错。
 * 3. 节点 id 子串（如输入含 `fort-douaumont`）。
 *
 * 找不到返回 null（绝不伪造节点）。
 *
 * @param input 玩家/LLM 输入文本（任意大小写）
 * @param nodes 高价值节点列表（含 id/name/cellId）
 * @returns 命中的节点或 null
 */
export function matchNodeByName(
  input: string,
  nodes: ReadonlyArray<{ id: string; name: string; cellId: string }>,
): { id: string; name: string; cellId: string } | null {
  const lower = input.toLowerCase()
  // 1) 全名直接 includes
  for (const n of nodes) {
    if (n.name.length > 0 && lower.includes(n.name.toLowerCase())) {
      return n
    }
  }
  // 2) 中文片段双向 includes（容错英文括注）
  for (const n of nodes) {
    const cn = nodeNameCn(n.name)
    if (cn.length > 0 && (lower.includes(cn.toLowerCase()) || cn.toLowerCase().includes(lower))) {
      return n
    }
  }
  // 3) 节点 id 子串
  for (const n of nodes) {
    if (n.id.length > 0 && lower.includes(n.id.toLowerCase())) {
      return n
    }
  }
  return null
}

/**
 * 取节点名的中文片段（去英文括注）。
 * 「杜奥蒙堡 (Fort Douaumont)」→「杜奥蒙堡」。
 * 用于 matchNode 双向容错与 fallbackMoveCoord 兜底。
 */
function nodeNameCn(name: string): string {
  return name.replace(/\s*[(（].*?[)）].*/g, '').trim()
}

/**
 * Bug1 修复：move 候选缺 targetCoord 时的兜底坐标（绝不伪造，仅取真实单位/节点坐标）。
 *
 * 兜底顺序：
 * 1. targetUnitId 存在且为真实单位 → 用该单位 coord（追击/靠拢敌军语义）。
 * 2. nodeId 存在且为真实节点 → 用节点 cellId 坐标（占领/接近目标点）。
 * 3. 都无 → 返回 null（候选将被剔除，转 clarify 让玩家补坐标）。
 *
 * @param cand LLM 候选命令（已通过 unitIds/attack/capture 校验）
 * @param world 当前世界状态
 * @returns 兜底坐标或 null
 */
function fallbackMoveCoord(
  cand: ChiefCandidateCommand,
  world: WorldState,
): GridCoord | null {
  // 1. targetUnitId 所在单位 coord
  if (cand.targetUnitId) {
    const tu = world.units.find((u) => u.id === cand.targetUnitId)
    if (tu) return { ...tu.coord }
  }
  // 2. nodeId 节点 cellId 坐标
  if (cand.nodeId) {
    const node = world.map.highValueNodes.find((n) => n.id === cand.nodeId)
    if (node) {
      const c = parseCellId(node.cellId)
      if (c !== null) return c
    }
  }
  return null
}

/**
 * 解析 cellId 为坐标；非法返回 null（第 3 批完善容错）。
 *
 * 支持三种 cellId 格式（运行时同时存在，互不统一）：
 * 1. `"col:row"`（如 `"2:3"`）—— supply.ts 运行时由 unit.coord 派生，
 *    测试与部分内部逻辑用此格式。
 * 2. `"cell-{col}-{row}"`（如 `"cell-7-2"`）—— 凡尔登等战役包 map.ts 的
 *    `cell.id` / `highValueNodes[].cellId` 风格。
 * 3. `"C3"` / `"c3"`（字母列+1 起步行号）—— 沙盘渲染层 SandboxRenderer 与
 *    玩家可见坐标标签风格（colToLetter + row+1）。
 *
 * 任一格式解析失败（如负数、非数字、列字母非法）返回 null。负值被拒绝
 * （不构成合法网格坐标）。
 *
 * 与 {@link coordFromCellId}（coords.ts）的差异：后者只支持「字母+数字」格式
 * 且解析失败抛错；本函数为 chief 内部兜底，需兼容三种格式且返回 null（不抛）。
 *
 * @param cellId 待解析的 cellId 字符串
 * @returns 坐标 {col,row}（0 起步）或 null（非法格式）
 */
export function parseCellId(cellId: string): GridCoord | null {
  if (typeof cellId !== 'string' || cellId.length === 0) return null
  const trimmed = cellId.trim()

  // 1) "col:row" 数字冒号格式（如 "2:3"）
  const colonMatch = /^(-?\d+)\s*:\s*(-?\d+)$/.exec(trimmed)
  if (colonMatch !== null) {
    const col = Number.parseInt(colonMatch[1], 10)
    const row = Number.parseInt(colonMatch[2], 10)
    if (Number.isNaN(col) || Number.isNaN(row) || col < 0 || row < 0) return null
    return { col, row }
  }

  // 2) "cell-{col}-{row}" 凡尔登 map.ts 风格（如 "cell-7-2"）
  const cellPrefixMatch = /^cell-(\d+)-(\d+)$/i.exec(trimmed)
  if (cellPrefixMatch !== null) {
    const col = Number.parseInt(cellPrefixMatch[1], 10)
    const row = Number.parseInt(cellPrefixMatch[2], 10)
    if (Number.isNaN(col) || Number.isNaN(row) || col < 0 || row < 0) return null
    return { col, row }
  }

  // 3) "C3" 字母列+1起步行号（如 "C3" → col=2, row=2）
  //    与 coords.coordFromCellId 同语义（A=0，行号 1 起 → row-1）。
  const letterMatch = /^([A-Za-z]+)\s*(\d+)$/.exec(trimmed)
  if (letterMatch !== null && letterMatch[1] !== undefined && letterMatch[2] !== undefined) {
    const col = letterToCol0(letterMatch[1])
    const row = Number.parseInt(letterMatch[2], 10) - 1
    if (Number.isNaN(col) || Number.isNaN(row) || col < 0 || row < 0) return null
    return { col, row }
  }

  return null
}

/**
 * 列字母转 0 起步列号（A=0, Z=25, AA=26...），非法返回 NaN。
 * 与 coords.letterToCol 同语义，但本文件避免反向 import 渲染层，内联一份。
 */
function letterToCol0(letter: string): number {
  const upper = letter.toUpperCase()
  if (!/^[A-Z]+$/.test(upper)) return Number.NaN
  let col = 0
  for (let i = 0; i < upper.length; i++) {
    col = col * 26 + (upper.charCodeAt(i) - 'A'.charCodeAt(0)) + 1
  }
  return col - 1
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

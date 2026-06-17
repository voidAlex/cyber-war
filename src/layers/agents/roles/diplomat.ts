/**
 * 外交官角色（diplomat.ts）— 玩家侧外交谈判 NPC（mock + 真 LLM 双实现）。
 *
 * 第 2+3 批「角色 tab 对话 UI」新增：与盟友/中立阵营进行自然语言外交谈判。
 *
 * **关键边界**：diplomat 是**纯对话角色**，与回合编排四角色（chief/theater/
 * commander/director）不同：
 * - **不参与 turn-resolution**（不写 event-log、不进 sequence 段、不进 replay）。
 * - 仅在角色 tab「外交官」下与玩家对话（请求盟友空中支援 / 协调进攻等）。
 * - 真正的外交信任度变化仍由 diplomacy-request 域函数 + director 终裁驱动
 *   （diplomat.chat 的回复是叙事性的，不直接改 trust 数值）。
 *
 * 两种实现：
 * - **mock 对话**（createDiplomatRole / diplomatRole）：基于当前阵营关系 + 信任度
 *   的模板回复。离线/测试/LLM 失败兜底。
 * - **真 LLM 对话**（createLlmDiplomatRole）：经 llm-service.streamTextWithDeltas
 *   （diplomat persona，多轮历史），失败回退 mock。
 *
 * 接口与 chief.chat 对齐（input/ctx/history/onDelta），便于 useCommandDialogue 统一路由。
 *
 * @module layers/agents/roles/diplomat
 */

import type { WorldState, DialogueTurn } from '@/types'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from './llm-role-base'
import {
  buildChatMessagesForRole,
} from '@/layers/agents/protocol/context-builder'
import { isLlmCallError } from './role-errors'

/**
 * 外交官对话所需的世界状态视图（最小依赖，便于测试注入）。
 *
 * 与 ChiefParseContext 对齐（world + playerFactionId），便于 useCommandDialogue
 * 统一传同一 ctx 给 chief/diplomat/commander。
 */
export interface DiplomatChatContext {
  /** 当前世界状态（阵营关系/信任度来源） */
  world: WorldState
  /** 玩家阵营 id（确定「我方」与「盟友/对手」视角） */
  playerFactionId: string
}

/**
 * 外交官对话回复结果（与 ChiefChatResult 同构，便于 UI 统一渲染）。
 */
export interface DiplomatChatResult {
  /** 回复文本（外交官人格口吻，基于真实阵营关系/信任度） */
  text: string
  /** 来源：mock 规则模板 / LLM。便于 UI/日志区分 */
  source: 'mock' | 'llm'
}

/**
 * 外交官角色实例接口（mock + LLM 共用签名）。
 *
 * 与 ChiefRole.chat 签名对齐（input/ctx/history/onDelta），便于 useCommandDialogue
 * 统一调度。仅 chat 一个方法（diplomat 不解析命令）。
 */
export interface DiplomatRole {
  /**
   * 与外交官自然语言对话（请求支援/协调/谈判，多轮上下文）。
   *
   * 多轮上下文：history 传最近 N 轮（玩家+外交官交替），外交官能援引上文。
   * 历史注入 LLM 的 L2 之后、L3 之前（buildChatMessagesForRole），不破坏缓存前缀。
   *
   * **流式 onDelta**：可选回调，LLM 每产出一段文本片段时回调，UI（store liveChat）
   * 据此逐字渲染气泡。mock 实现一次性全量回调（模拟瞬时完成）。
   *
   * @param input 玩家自然语言（如「请向盟友请求空中支援」）
   * @param ctx 世界状态视图
   * @param history 最近 N 轮对话历史（player/chief→外交官）
   * @param onDelta 可选：每个文本片段到达时回调（实时 partial，UI 打字机用）
   * @returns 对话回复文本（mock 模板 或 LLM 外交官人格回复）
   */
  chat(
    input: string,
    ctx: DiplomatChatContext,
    history?: readonly DialogueTurn[],
    onDelta?: (partial: string) => void,
  ): Promise<DiplomatChatResult>
}

// =============================================================================
// mock 对话实现（基于阵营关系 + 信任度的模板回复）
// =============================================================================

/**
 * 创建 mock 外交官（基于当前阵营关系 + 信任度的模板回复）。
 *
 * 模板分支：
 * - 问候 → 回礼 + 当前盟友关系简报。
 * - 请求支援（空中/炮兵/物资）→ 按信任度高低给应允/婉拒/附条件模板。
 * - 谈判/协调 → 通用外交官口吻回复（利益交换措辞）。
 * - 其他 → 引导明确请求。
 *
 * 绝不虚构：仅基于真实 faction.trust / faction.relations 生成。
 */
export function createDiplomatRole(): DiplomatRole {
  return {
    async chat(input, ctx, history, onDelta) {
      return diplomatChatMock(input, ctx, history, onDelta)
    },
  }
}

/** 默认 mock 外交官实例 */
export const diplomatRole: DiplomatRole = createDiplomatRole()

/**
 * mock 外交官对话实现（纯函数模板，离线/降级/LLM 失败时兜底）。
 *
 * 基于当前盟友阵营的 trust 值生成回复，绝不虚构盟约或援助。
 */
function diplomatChatMock(
  input: string,
  ctx: DiplomatChatContext,
  _history: readonly DialogueTurn[] | undefined,
  onDelta?: (partial: string) => void,
): DiplomatChatResult {
  const world = ctx.world
  const playerFaction =
    world.factions.find((f) => f.id === ctx.playerFactionId) ?? null

  // 查盟友阵营（优先 relations=allied，fallback side=ally）
  const allyFaction = playerFaction
    ? world.factions.find(
        (f) =>
          f.id !== playerFaction.id &&
          (f.relations?.[playerFaction.id] === 'allied' || f.side === 'ally'),
      )
    : undefined

  // 盟友信任度（无盟友时 0）
  const trustValue =
    playerFaction && allyFaction
      ? (allyFaction.trust[playerFaction.id] ?? 50)
      : 0

  // 盟友名（无盟友时提示无可谈判对象）
  const allyName = allyFaction?.name ?? '盟友'

  const lower = input.trim().toLowerCase()

  // 问候
  if (/你好|您好|hi|hello|嗨|早|晚上好|下午好|早上好/i.test(input)) {
    const text = allyFaction
      ? `总司令，外交官报到。当前与${allyName}信任度约 ${trustValue}（${describeTrust(trustValue)}）。${trustValue >= 60 ? '关系稳固，可推进更深合作。' : trustValue >= 30 ? '尚可维系，但需谨慎措辞。' : '关系紧张，谈判空间有限。'}请指示交涉方向。`
      : `总司令，外交官报到。当前战局无明确盟友阵营，外交斡旋缺乏对象。如需联络中立方，请明示。`
    return emitMock(text, onDelta)
  }

  // 请求支援（空中/炮兵/物资/援军）
  if (/空中|空军|战机|飞机|air/i.test(input)) {
    return emitMock(buildSupportReply('空中支援', trustValue, allyName, allyFaction !== undefined), onDelta)
  }
  if (/炮兵|炮火|炮击|artillery/i.test(input)) {
    return emitMock(buildSupportReply('炮火支援', trustValue, allyName, allyFaction !== undefined), onDelta)
  }
  if (/物资|补给|弹药|后勤|supply/i.test(input)) {
    return emitMock(buildSupportReply('物资补给', trustValue, allyName, allyFaction !== undefined), onDelta)
  }
  if (/援军|增援|兵力|reinforce/i.test(input)) {
    return emitMock(buildSupportReply('兵力增援', trustValue, allyName, allyFaction !== undefined), onDelta)
  }

  // 通用请求/谈判（含「请求」「请」「支援」「协调」「谈判」等）
  if (/请求|请向|请予|支援|协调|谈判|斡旋|交涉|联盟|结盟/.test(input) || lower.includes('request')) {
    return emitMock(buildSupportReply('所请之事', trustValue, allyName, allyFaction !== undefined), onDelta)
  }

  // 询问态势/建议
  if (/建议|怎么办|怎么看|态势|关系|信任/.test(input)) {
    const text = allyFaction
      ? `总司令，依外交判断：与${allyName}当前信任度 ${trustValue}。${trustValue >= 60 ? '可大胆请求关键支援，对方应允概率较高。' : trustValue >= 30 ? '建议先以小规模合作累积信任，再图大请。' : '贸然请求恐遭婉拒，宜先履行既有承诺修复关系。'}`
      : `总司令，当前无盟友可外交斡旋，建议专注军事调度。`
    return emitMock(text, onDelta)
  }

  // 兜底引导
  const text = `总司令，请明示交涉对象与诉求（如「请向${allyName}请求空中支援」），我好拟定措辞。`
  return emitMock(text, onDelta)
}

/** 把 mock 回复一次性全量回调 onDelta（模拟瞬时完成，统一 UI 打字机逻辑路径）。 */
function emitMock(
  text: string,
  onDelta?: (partial: string) => void,
): DiplomatChatResult {
  if (onDelta && text.length > 0) {
    onDelta(text)
  }
  return { text, source: 'mock' }
}

/** 信任度档位描述（mock 简报用）。 */
function describeTrust(trust: number): string {
  if (trust >= 70) return '坚固'
  if (trust >= 50) return '良好'
  if (trust >= 30) return '一般'
  if (trust >= 15) return '紧张'
  return '濒临破裂'
}

/**
 * 构造「请求某类支援」的外交回复（按信任度档位）。
 *
 * - trust ≥ 60：应允，语气积极。
 * - 30 ≤ trust < 60：附条件应允（需利益交换）。
 * - trust < 30：婉拒或敷衍。
 * - 无盟友：无可谈判对象。
 */
function buildSupportReply(
  kind: string,
  trust: number,
  allyName: string,
  hasAlly: boolean,
): string {
  if (!hasAlly) {
    return `总司令，当前无盟友阵营，${kind}之请无从谈起。建议先确立同盟关系。`
  }
  if (trust >= 60) {
    return `总司令，我已向${allyName}转达${kind}之请。鉴于双方信任稳固，对方已原则应允，将尽快部署。请总司令统筹接应。`
  }
  if (trust >= 30) {
    return `总司令，关于${kind}之请，${allyName}未即拒，但提出需以相应利益交换（如分担某段防线/共享情报）。是否接受其条件，请总司令定夺。`
  }
  return `总司令，${kind}之请，${allyName}以「前线吃紧、兵力捉襟」为由婉拒。当前信任度偏低，宜先履行既有承诺修复关系，再图后请。`
}

// =============================================================================
// 真 LLM 对话实现（diplomat persona + 多轮历史，失败回退 mock）
// =============================================================================

/** 真 LLM 外交官角色（第 2+3 批） */
export interface LlmDiplomatRole extends DiplomatRole {
  /** 注入的 LLM 服务 */
  readonly llm: LlmService
  /** 注入的 LLM 调用配置 */
  readonly config: LlmCallConfig
}

/**
 * 创建真 LLM 外交官（第 2+3 批）。
 *
 * messages 构造走 context-builder.buildChatMessagesForRole('diplomat', ...)：
 * - L0 用 DIPLOMAT_CHAT_PERSONA_PROMPT（外交官人格，固定）。
 * - L1 战役数据 / L2 世界摘要 / history / L3 任务，与 chief.chat 同构。
 *
 * 用 llmService.streamTextWithDeltas 拿纯文本回复，边出边显示（打字机）。
 * 失败抛 LlmCallError，由本函数上层回退 mock 模板。
 */
export function createLlmDiplomatRole(
  llmService: LlmService,
  config: LlmCallConfig,
): LlmDiplomatRole {
  return {
    llm: llmService,
    config,
    async chat(input, ctx, history, onDelta) {
      try {
        return await diplomatChatWithLlm(input, ctx, llmService, config, history, onDelta)
      } catch (err) {
        // LLM 失败：回退 mock 模板回复（绝不卡死对话）。
        // eslint-disable-next-line no-console
        console.error('[diplomat] LLM 对话失败，回退 mock 模板回复:', err)
        if (isLlmCallError(err)) {
          return diplomatChatMock(input, ctx, history, onDelta)
        }
        throw err
      }
    },
  }
}

/**
 * 真 LLM 外交官对话实现（多轮上下文）。
 *
 * @param history 最近 N 轮对话历史（player/chief→外交官），注入 L2 之后让外交官有记忆
 * @param onDelta 可选：每个文本片段到达时回调（实时 partial，UI 打字机用）。
 *   仅 UI 副作用，不影响 prompt 结构/缓存前缀。
 * @throws LlmCallError（四分类/degraded）由上层回退 mock
 */
async function diplomatChatWithLlm(
  input: string,
  ctx: DiplomatChatContext,
  llmService: LlmService,
  config: LlmCallConfig,
  history?: readonly DialogueTurn[],
  onDelta?: (partial: string) => void,
): Promise<DiplomatChatResult> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    // 空输入直接走 mock（不浪费 LLM 调用）
    return diplomatChatMock(input, ctx, history, onDelta)
  }

  // buildChatMessagesForRole 负责 L0-L3 分层 + history 转换（diplomat persona）
  const messages = buildChatMessagesForRole('diplomat', {
    worldState: ctx.world,
    // L3 任务文本：回合号属 L3 安全（system prompt 不含回合号）
    task: `（当前第 ${ctx.world.turnIndex} 回合，${ctx.world.inGameDate}）\n总司令说："${trimmed}"\n请以外交官口吻回复。`,
    history: history,
  })

  // streamTextWithDeltas：消费 gateway async iterator，onDelta 在每个 text 片段到达时回调。
  const result = await llmService.streamTextWithDeltas(
    {
      provider: config.provider,
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      // 对话用稍高温度增加自然度；若 config 已设 extraParams 则合并
      extraParams: { temperature: 0.7, ...(config.extraParams ?? {}) },
    },
    onDelta,
  )

  const text = result.text.trim()
  if (text.length === 0) {
    // LLM 返回空：回退 mock（不伪造，用模板）
    return diplomatChatMock(input, ctx, history, onDelta)
  }
  return { text, source: 'llm' }
}

/**
 * 玩家方指挥官对话角色（player-commander.ts）— 角色 tab「指挥官」NPC。
 *
 * 第 2+3 批「角色 tab 对话 UI」新增：与玩家方某建制单位的指挥官（如炮兵司令、
 * 要塞守备）进行自然语言对话——汇报战备、当面敌情、战术建议。
 *
 * **关键边界**（与 diplomat.ts 同理）：这是**纯对话角色**，不参与 turn-resolution
 * （不写 event-log、不进 sequence、不进 replay）。与现有敌方 AI 决策的
 * CommanderRole（commander.ts，resolve() 签名）完全不同——此处是「玩家方某指挥官
 * 向总司令报告」的对话 NPC，仅 chat 一个方法。
 *
 * **responsibleUnits**：玩家方指挥官对话聚焦其负责的单位子集（如炮兵司令只汇报
 * 炮兵单位战备）。来自 AIRoleDef.responsibleUnits，由 useCommandDialogue 注入。
 *
 * 两种实现：
 * - **mock 对话**（createPlayerCommanderRole）：基于负责单位战备的模板回复。
 * - **真 LLM 对话**（createLlmPlayerCommanderRole）：commander persona + 多轮历史。
 *
 * @module layers/agents/roles/player-commander
 */

import type { WorldState, DialogueTurn, Unit } from '@/types'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from './llm-role-base'
import {
  buildChatMessagesForRole,
} from '@/layers/agents/protocol/context-builder'
import { isLlmCallError } from './role-errors'

/**
 * 玩家方指挥官对话所需的世界状态视图。
 *
 * playerFactionId 用于过滤「我方单位」；responsibleUnits 限定该指挥官负责的单位子集。
 */
export interface PlayerCommanderChatContext {
  /** 当前世界状态（单位战备来源） */
  world: WorldState
  /** 玩家阵营 id */
  playerFactionId: string
  /** 该指挥官负责的单位 id 列表（缺省=该阵营全部单位） */
  responsibleUnits?: readonly string[]
  /** 该指挥官的人类可读称呼（如「炮兵司令」「杜奥蒙守备指挥」） */
  title?: string
}

/** 玩家方指挥官对话回复结果（与 ChiefChatResult / DiplomatChatResult 同构）。 */
export interface PlayerCommanderChatResult {
  /** 回复文本（指挥官人格口吻，基于真实单位战备） */
  text: string
  /** 来源：mock 规则模板 / LLM */
  source: 'mock' | 'llm'
}

/** 玩家方指挥官角色实例接口（仅 chat，不参与编排）。 */
export interface PlayerCommanderRole {
  chat(
    input: string,
    ctx: PlayerCommanderChatContext,
    history?: readonly DialogueTurn[],
    onDelta?: (partial: string) => void,
  ): Promise<PlayerCommanderChatResult>
}

// =============================================================================
// mock 对话实现（基于负责单位战备的模板回复）
// =============================================================================

/**
 * 创建 mock 玩家方指挥官（基于负责单位战备的模板回复）。
 *
 * 模板分支：
 * - 问候/报到 → 报告负责单位战备概要（数量/平均强度/士气）。
 * - 问战备/状态 → 列出负责单位的位置与强度。
 * - 问敌情/建议 → 基于当面敌方单位给战术建议。
 * - 其他 → 引导明确询问。
 *
 * 绝不虚构：仅基于真实 world.units 中本方且属于 responsibleUnits 的单位。
 */
export function createPlayerCommanderRole(): PlayerCommanderRole {
  return {
    async chat(input, ctx, history, onDelta) {
      return playerCommanderChatMock(input, ctx, history, onDelta)
    },
  }
}

/** 默认 mock 玩家方指挥官实例 */
export const playerCommanderRole: PlayerCommanderRole = createPlayerCommanderRole()

/**
 * mock 玩家方指挥官对话实现（纯函数模板，离线/降级/LLM 失败时兜底）。
 */
function playerCommanderChatMock(
  input: string,
  ctx: PlayerCommanderChatContext,
  _history: readonly DialogueTurn[] | undefined,
  onDelta?: (partial: string) => void,
): PlayerCommanderChatResult {
  const title = ctx.title ?? '指挥官'
  const myUnits = pickMyUnits(ctx)
  const enemyUnits = ctx.world.units.filter((u) => u.factionId !== ctx.playerFactionId)

  // 问候/报到
  if (/你好|您好|hi|hello|嗨|报到|早/.test(input)) {
    const text = myUnits.length > 0
      ? `总司令，${title}报到。所辖 ${myUnits.length} 个建制就位：平均强度 ${avgStrength(myUnits)}，士气 ${avgMorale(myUnits)}。${enemyUnits.length > 0 ? `当面之敌约 ${enemyUnits.length} 个建制。` : ''}请下令。`
      : `总司令，${title}报到。当前所辖单位暂无在编建制，待补充。`
    return emitMock(text, onDelta)
  }

  // 问战备/状态
  if (/战备|状态|怎么样|态势|报告|汇报/.test(input)) {
    if (myUnits.length === 0) {
      return emitMock(`总司令，所辖单位暂无在编建制，无从汇报。`, onDelta)
    }
    const brief = myUnits
      .slice(0, 4)
      .map((u) => `${UNIT_TYPE_CN[u.type] ?? u.type}（${u.coord.col},${u.coord.row}，强度${u.strength}，士气${u.morale}）`)
      .join('；')
    const text = `总司令，所辖战备：${brief}。${lowMoraleNote(myUnits)}`
    return emitMock(text, onDelta)
  }

  // 问敌情/建议
  if (/敌情|敌人|敌方|建议|怎么办|怎么看|进攻|防御/.test(input)) {
    if (enemyUnits.length === 0) {
      return emitMock(`总司令，当面未发现敌军建制，所辖单位可休整补充。`, onDelta)
    }
    const text = `总司令，依所辖判断：当面敌军约 ${enemyUnits.length} 个建制。${suggestByType(myUnits)}请总司令定夺。`
    return emitMock(text, onDelta)
  }

  // 兜底引导
  const text = `总司令，请明示指示：询问所辖战备、当面敌情，还是战术建议？`
  return emitMock(text, onDelta)
}

/** 取该指挥官负责的本方单位（按 responsibleUnits 过滤；缺省=本方全部）。 */
function pickMyUnits(ctx: PlayerCommanderChatContext): Unit[] {
  const own = ctx.world.units.filter((u) => u.factionId === ctx.playerFactionId)
  if (!ctx.responsibleUnits || ctx.responsibleUnits.length === 0) return own
  const set = new Set(ctx.responsibleUnits)
  return own.filter((u) => set.has(u.id))
}

function avgStrength(units: readonly Unit[]): number {
  if (units.length === 0) return 0
  return Math.round(units.reduce((s, u) => s + u.strength, 0) / units.length)
}

function avgMorale(units: readonly Unit[]): number {
  if (units.length === 0) return 0
  return Math.round(units.reduce((s, u) => s + u.morale, 0) / units.length)
}

/** 低士气预警（平均士气 <40 时提示）。 */
function lowMoraleNote(units: readonly Unit[]): string {
  const m = avgMorale(units)
  if (m < 40) return `注意：平均士气偏低（${m}），建议轮换休整。`
  return ''
}

/** 按所辖单位类型主力给战术建议（mock 简化）。 */
function suggestByType(units: readonly Unit[]): string {
  const hasArtillery = units.some((u) => u.type === 'artillery')
  const hasFortress = units.some((u) => u.type === 'fortress')
  if (hasArtillery) return `炮兵已就位，可对敌集结地域实施压制射击，为步兵冲击创造战机。`
  if (hasFortress) return `要塞守备依托工事，建议固守要点，消耗敌攻击动能。`
  return `建议集中所辖建制，伺机反击或巩固现阵地。`
}

/** 单位类型中文名（mock 简报用）。 */
const UNIT_TYPE_CN: Record<Unit['type'], string> = {
  infantry: '步兵',
  armor: '装甲',
  artillery: '炮兵',
  recon: '侦察',
  fortress: '要塞',
  support: '后勤',
  air: '空军',
  naval: '海军',
  missile: '导弹',
}

/** 把 mock 回复一次性全量回调 onDelta（模拟瞬时完成）。 */
function emitMock(
  text: string,
  onDelta?: (partial: string) => void,
): PlayerCommanderChatResult {
  if (onDelta && text.length > 0) {
    onDelta(text)
  }
  return { text, source: 'mock' }
}

// =============================================================================
// 真 LLM 对话实现（commander persona + 多轮历史，失败回退 mock）
// =============================================================================

/** 真 LLM 玩家方指挥官角色（第 2+3 批） */
export interface LlmPlayerCommanderRole extends PlayerCommanderRole {
  readonly llm: LlmService
  readonly config: LlmCallConfig
}

/**
 * 创建真 LLM 玩家方指挥官（第 2+3 批）。
 *
 * messages 走 buildChatMessagesForRole('commander', ...)；L3 任务文本附所辖单位战备
 * 摘要（让 LLM 知道该指挥官负责哪些单位）。失败回退 mock。
 */
export function createLlmPlayerCommanderRole(
  llmService: LlmService,
  config: LlmCallConfig,
): LlmPlayerCommanderRole {
  return {
    llm: llmService,
    config,
    async chat(input, ctx, history, onDelta) {
      try {
        return await playerCommanderChatWithLlm(input, ctx, llmService, config, history, onDelta)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[player-commander] LLM 对话失败，回退 mock 模板回复:', err)
        if (isLlmCallError(err)) {
          return playerCommanderChatMock(input, ctx, history, onDelta)
        }
        throw err
      }
    },
  }
}

/**
 * 真 LLM 玩家方指挥官对话实现（多轮上下文）。
 *
 * @throws LlmCallError（四分类/degraded）由上层回退 mock
 */
async function playerCommanderChatWithLlm(
  input: string,
  ctx: PlayerCommanderChatContext,
  llmService: LlmService,
  config: LlmCallConfig,
  history?: readonly DialogueTurn[],
  onDelta?: (partial: string) => void,
): Promise<PlayerCommanderChatResult> {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return playerCommanderChatMock(input, ctx, history, onDelta)
  }

  const myUnits = pickMyUnits(ctx)
  // L3 任务文本：附所辖单位战备摘要 + 职务（让 LLM 知道「我是谁、管哪些单位」）
  const unitsBrief = myUnits
    .slice(0, 8)
    .map((u) => `${u.id}(${UNIT_TYPE_CN[u.type] ?? u.type},${u.coord.col},${u.coord.row},强度${u.strength},士气${u.morale})`)
    .join('; ')
  const titleLine = ctx.title ? `你是${ctx.title}。` : ''
  const task = `${titleLine}（当前第 ${ctx.world.turnIndex} 回合，${ctx.world.inGameDate}）\n所辖单位：${unitsBrief || '暂无'}\n总司令说："${trimmed}"\n请以所辖单位指挥官口吻回复。`

  const messages = buildChatMessagesForRole('commander', {
    worldState: ctx.world,
    task,
    history: history,
  })

  const result = await llmService.streamTextWithDeltas(
    {
      provider: config.provider,
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      extraParams: { temperature: 0.7, ...(config.extraParams ?? {}) },
    },
    onDelta,
  )

  const text = result.text.trim()
  if (text.length === 0) {
    return playerCommanderChatMock(input, ctx, history, onDelta)
  }
  return { text, source: 'llm' }
}

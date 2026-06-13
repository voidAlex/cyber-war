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
 * 参谋长角色实例（M2 mock，M3 可替换为 LLM 实现）。
 *
 * 无状态：每次 parseCommand 独立解析，不持有会话历史。
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
 * 创建 M2 mock 参谋长（规则解析）。
 *
 * M3 时替换为真 LLM 实现（保持 parseCommand 签名不变）。
 */
export function createChiefRole(): ChiefRole {
  return {
    async parseCommand(input, ctx) {
      return parseCommandMock(input, ctx)
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
        if (isLlmCallError(err)) {
          // LLM 失败：回退 mock 规则解析（绝不伪造，绝不卡死游戏）
          return parseCommandMock(input, ctx)
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

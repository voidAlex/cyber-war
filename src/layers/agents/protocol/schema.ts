/**
 * Agent 输出 JSON Schema + 结构化解析（schema.ts）— 纯函数边界。
 *
 * 对应审计教训「解析失败伪造 unit-1/C3」：LLM 输出必须经 ajv 严格校验，
 * 校验失败 **throw**（绝不伪造兜底数据，由上层规则引擎降级）。
 *
 * 本模块为纯函数：只依赖 ajv/ajv-formats，不调 Tauri/fetch/crypto/Date.now。
 *
 * 四类 Agent 输出 schema：
 * - chief（参谋长）：候选命令列表（待玩家握手确认）。
 * - theater（战区司令）：把命令拆解为执行单元 + 坐标。
 * - commander（敌/盟统帅）：阵营决策。
 * - director（导演部终裁）：终裁战报 + 数值覆写留痕。
 *
 * @module layers/agents/protocol/schema
 */

import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'

// =============================================================================
// ajv 实例（单例，draft-07，启用严格模式）
// =============================================================================

/**
 * 共享 ajv 实例（启用 strict + formats）。
 *
 * 各 schema 用 `ajv.compile` 编译成 ValidateFunction 并缓存，避免重复编译开销。
 * 调用方也可传入自己的 ajv 实例（便于测试注入）。
 */
export function createAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true })
  addFormats(ajv)
  return ajv
}

/** 单例 ajv（懒加载，避免在纯函数模块 import 阶段就构造） */
let _ajv: Ajv | null = null
function defaultAjv(): Ajv {
  if (!_ajv) _ajv = createAjv()
  return _ajv
}

// =============================================================================
// 四类 Agent 输出 JSON Schema（draft-07）
// =============================================================================

/**
 * 坐标 schema（与 types/unit GridCoord 对齐）。
 * 缓存命中友好：作为 $defs 复用，避免重复定义。
 */
const coordSchema = {
  type: 'object',
  properties: {
    col: { type: 'integer', minimum: 0 },
    row: { type: 'integer', minimum: 0 },
  },
  required: ['col', 'row'],
  additionalProperties: false,
} as const

/**
 * 参谋长（chief）输出：候选命令列表。
 *
 * 解析玩家自然语言 → 1..N 条候选命令，每条含意图/单位/目标坐标。
 * 注意：unitIds 必须引用真实 WorldState.units（解析失败不伪造）。
 * 后续 handshake 由玩家逐条确认/修改。
 */
export const CHIEF_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'agent-output/chief',
  title: 'ChiefAgentOutput',
  type: 'object',
  properties: {
    /** 候选命令列表（至少 1 条） */
    candidates: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          /** 命令意图（move/attack/capture_node/hold） */
          intent: {
            type: 'string',
            enum: ['move', 'attack', 'capture_node', 'hold', 'recon', 'entrench'],
          },
          /** 执行单位 id（来自真实 WorldState.units，绝不伪造） */
          unitIds: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
          /** 目标坐标（move/capture_node 用；hold 可空） */
          targetCoord: { $ref: '#/$defs/coord' },
          /** 被攻击单位 id（attack 用） */
          targetUnitId: { type: 'string', minLength: 1 },
          /** 高价值节点 id（capture_node 用） */
          nodeId: { type: 'string', minLength: 1 },
          /** 参谋长自然语言解读（显示给玩家辅助确认） */
          summary: { type: 'string', minLength: 1 },
          /** 置信度 0..1 */
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['intent', 'unitIds', 'summary', 'confidence'],
        additionalProperties: false,
      },
    },
    /** 整体澄清说明（若需玩家补充信息） */
    note: { type: 'string' },
  },
  required: ['candidates'],
  additionalProperties: false,
  $defs: { coord: coordSchema },
} as const

/** 参谋长输出 TS 类型（与 schema 对齐） */
export interface ChiefCandidateCommand {
  intent: 'move' | 'attack' | 'capture_node' | 'hold' | 'recon' | 'entrench'
  unitIds: string[]
  targetCoord?: { col: number; row: number }
  targetUnitId?: string
  nodeId?: string
  summary: string
  confidence: number
}
export interface ChiefAgentOutput {
  candidates: ChiefCandidateCommand[]
  note?: string
}

/**
 * 战区司令（theater）输出：命令拆解为可执行的单位级动作。
 *
 * 每个原命令拆成若干 unit-action，含执行单位/意图/目标。
 * seed 由编排层注入（scenarioSeed:turn:sequence），保证物理结算可回放。
 */
export const THEATER_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'agent-output/theater',
  title: 'TheaterAgentOutput',
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          /** 来源候选命令序号（chief.candidates 的 index） */
          sourceCandidateIndex: { type: 'integer', minimum: 0 },
          /** 执行单位 id（真实单位） */
          unitId: { type: 'string', minLength: 1 },
          intent: {
            type: 'string',
            enum: ['move', 'attack', 'capture_node', 'hold', 'recon', 'entrench'],
          },
          targetCoord: { $ref: '#/$defs/coord' },
          targetUnitId: { type: 'string', minLength: 1 },
          nodeId: { type: 'string', minLength: 1 },
        },
        required: ['unitId', 'intent'],
        additionalProperties: false,
      },
    },
    /** 战区司令战术说明 */
    tacticalNote: { type: 'string' },
  },
  required: ['actions'],
  additionalProperties: false,
  $defs: { coord: coordSchema },
} as const

/** 战区司令输出 TS 类型 */
export interface TheaterUnitAction {
  sourceCandidateIndex?: number
  unitId: string
  intent: 'move' | 'attack' | 'capture_node' | 'hold' | 'recon' | 'entrench'
  targetCoord?: { col: number; row: number }
  targetUnitId?: string
  nodeId?: string
}
export interface TheaterAgentOutput {
  actions: TheaterUnitAction[]
  tacticalNote?: string
}

/**
 * 敌/盟统帅（commander）输出：阵营决策。
 *
 * 非玩家阵营在已知情报下做出的本回合行动决策。
 * 服从度（obedience）低的统帅可能抗命，由 director 终裁判概率。
 */
export const COMMANDER_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'agent-output/commander',
  title: 'CommanderAgentOutput',
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          unitId: { type: 'string', minLength: 1 },
          intent: {
            type: 'string',
            enum: ['move', 'attack', 'capture_node', 'hold', 'recon', 'entrench'],
          },
          targetCoord: { $ref: '#/$defs/coord' },
          targetUnitId: { type: 'string', minLength: 1 },
          nodeId: { type: 'string', minLength: 1 },
          /** 决策理由（人格/态势依据，留痕） */
          rationale: { type: 'string', minLength: 1 },
        },
        required: ['unitId', 'intent', 'rationale'],
        additionalProperties: false,
      },
    },
    /** 是否抗命（obedience 低时可能，director 终裁参考） */
    disobeying: { type: 'boolean' },
  },
  required: ['decisions'],
  additionalProperties: false,
  $defs: { coord: coordSchema },
} as const

/** 敌/盟统帅输出 TS 类型 */
export interface CommanderDecision {
  unitId: string
  intent: 'move' | 'attack' | 'capture_node' | 'hold' | 'recon' | 'entrench'
  targetCoord?: { col: number; row: number }
  targetUnitId?: string
  nodeId?: string
  rationale: string
}
export interface CommanderAgentOutput {
  decisions: CommanderDecision[]
  disobeying?: boolean
}

/**
 * 导演部（director）终裁输出：战报 + 数值覆写留痕。
 *
 * 物理层先按规则算出「物理真相」，director 可覆写数值（必须留痕），
 * 并产出叙事战报（「记录即真相」，回放直接采信不重算）。
 *
 * overrides 字段是审计教训「director 覆写必须留痕」的落点。
 */
export const DIRECTOR_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'agent-output/director',
  title: 'DirectorAgentOutput',
  type: 'object',
  properties: {
    /** 本回合叙事战报（导演润色，briefing 展示） */
    reportText: { type: 'string', minLength: 1 },
    /** 数值覆写留痕（物理真相 → director 修正值，每条必含 reason） */
    overrides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          /** 被覆写字段（如 units.first-armor.strength） */
          field: { type: 'string', minLength: 1 },
          before: {},
          after: {},
          reason: { type: 'string', minLength: 1 },
        },
        required: ['field', 'before', 'after', 'reason'],
        additionalProperties: false,
      },
    },
    /** 关键事件标记（用于 directorMemory.keyEvents） */
    keyEvents: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['reportText'],
  additionalProperties: false,
} as const

/** 导演部输出 TS 类型 */
export interface DirectorOverride {
  field: string
  before: unknown
  after: unknown
  reason: string
}
export interface DirectorAgentOutput {
  reportText: string
  overrides?: DirectorOverride[]
  keyEvents?: string[]
}

/**
 * 各 Agent 角色 → 输出 schema 的映射表（供上下文构造器引用 schema 说明）。
 */
export const AGENT_OUTPUT_SCHEMAS = {
  chief: CHIEF_OUTPUT_SCHEMA,
  theater: THEATER_OUTPUT_SCHEMA,
  commander: COMMANDER_OUTPUT_SCHEMA,
  director: DIRECTOR_OUTPUT_SCHEMA,
} as const

// =============================================================================
// parseLLMJson：剥离 markdown fence → JSON.parse → ajv 校验
// =============================================================================

/** LLM 结构化输出解析失败的 typed error（上层据此决定降级策略） */
export class LlmJsonParseError extends Error {
  constructor(
    message: string,
    readonly errors: Array<Record<string, unknown>> | null,
  ) {
    super(message)
    this.name = 'LlmJsonParseError'
  }
}

/**
 * 剥离 markdown ```json fence，返回 JSON 文本。
 *
 * 处理 LLM 常见输出格式：
 * - ```json\n{...}\n``` （带语言标签的 fence）
 * - ```\n{...}\n``` （无标签 fence）
 * - 纯 JSON（无 fence）
 * - fence 前后有解释文本（取第一个 { 到最后一个 }）
 *
 * 纯函数，不调用 JSON.parse（仅做字符串裁剪），便于单测边界。
 */
export function stripMarkdownFence(raw: string): string {
  const text = raw.trim()

  // 形如 ```json ... ``` 或 ``` ... ``` 的整段 fence
  const fenceMatch = text.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```\s*$/)
  if (fenceMatch) {
    return fenceMatch[1].trim()
  }

  // 含 fence 但首尾有多余文本：取第一个 ``` 到最后一个 ```
  const firstFence = text.indexOf('```')
  const lastFence = text.lastIndexOf('```')
  if (firstFence !== -1 && lastFence !== firstFence) {
    const inner = text.slice(firstFence + 3, lastFence)
    // 去掉首行的语言标签（json/JSON）
    const nl = inner.indexOf('\n')
    const body = nl >= 0 ? inner.slice(nl + 1) : inner
    return body.trim()
  }

  // 无 fence 但首尾有多余解释文本：取第一个 { 到最后一个 }（或 [ 到 ]）
  if (!text.startsWith('{') && !text.startsWith('[')) {
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1).trim()
    }
  }

  return text
}

/**
 * Bug B 修复：LLM 输出常见脏字符修复链（在 JSON.parse 前应用）。
 *
 * 处理 LLM 输出常见的非严格 JSON 问题（顺序：标点 → 逗号 → 截断）：
 * 1. **中文标点 → 英文**：`，`→`,`、`：`→`:`、`"`/`"`/`「`/`」`→`"`。
 *    LLM 在中文上下文里偶尔会把 JSON 字段分隔符写成中文全角标点，
 *    导致 `JSON.parse` 报 "Expected ',' or '}'" 类错误。
 * 2. **trailing comma**：`,}` → `}`、`,]` → `]`（LLM 常多打尾逗号）。
 * 3. **截断补全**：若字符串以未闭合的 `{`/`[` 开头（缺末尾配对括号），
 *    按括号深度尝试追加缺失的 `}`/`]`（仅当大括号/方括号不配对时）。
 *
 * 纯函数，不做 JSON.parse（仅字符串修复），失败回退原样（让 JSON.parse 报原始错）。
 *
 * @param stripped 已剥离 fence / 提取 JSON 块后的文本
 * @returns 修复后的文本（若修复失败回退原文）
 */
export function repairLLMJson(stripped: string): string {
  if (stripped.length === 0) return stripped
  let s = stripped

  // 1) 中文标点 → 英文（仅替换 JSON 结构相关的全角标点；
  //    字符串内容里的中文标点不被触碰——见下方"字符串内不替换"守卫）。
  //    为避免误改字符串内容（如 reportText 里的中文段落），仅在「不在双引号字符串内」时替换。
  s = replaceOutsideStrings(s, [
    [/，/g, ','],
    [/：/g, ':'],
    [/“/g, '"'],
    [/”/g, '"'],
    [/「/g, '"'],
    [/」/g, '"'],
  ])

  // 2) trailing comma → 移除（仅结构层，逗号紧跟 } 或 ] 之前）
  //    `,\s*}` → `}`、`,\s*]` → `]`。同样绕开字符串内容。
  s = replaceOutsideStrings(s, [
    [/,\s*}/g, '}'],
    [/,\s*]/g, ']'],
  ])

  // 3) 截断补全：若以 { 或 [ 开头但括号不配对，追加缺失的右括号。
  //    仅当首字符是 { 或 [ 时尝试（避免对纯文本误补全）。
  const first = s.trim()[0]
  if (first === '{' || first === '[') {
    s = repairTruncated(s)
  }

  return s
}

/**
 * 在「双引号字符串外」执行一组正则替换（字符串内的内容不被动）。
 *
 * 简化状态机：遍历字符，遇 `"` 切换 inString 状态（处理 `\"` 转义）。
 * 仅在 inString===false 时记录字符并应用替换；字符串内的字符原样保留。
 *
 * 用于 repairLLMJson 的标点/trailing-comma 修复，避免误改 reportText 等中文段落。
 *
 * @param text 原始文本
 * @param replacements 一组 [RegExp, replacement] 替换规则（全局正则）
 * @returns 替换后的文本
 */
function replaceOutsideStrings(
  text: string,
  replacements: ReadonlyArray<[RegExp, string]>,
): string {
  // 把文本切成「字符串段」与「结构段」交替，仅对结构段做替换。
  const segments: Array<{ text: string; inString: boolean }> = []
  let cur = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      cur += ch
      // 处理转义：\" 不结束字符串
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[i + 1]
        i += 1
        continue
      }
      if (ch === '"') {
        // 结束当前字符串段
        segments.push({ text: cur, inString: true })
        cur = ''
        inString = false
      }
      continue
    }
    // 结构段
    if (ch === '"') {
      // 把累积的结构段先 flush
      if (cur.length > 0) {
        segments.push({ text: cur, inString: false })
        cur = ''
      }
      cur = '"'
      inString = true
      continue
    }
    cur += ch
  }
  // flush 末尾段
  if (cur.length > 0) {
    segments.push({ text: cur, inString })
  }

  // 仅对结构段（inString===false）应用替换
  let out = ''
  for (const seg of segments) {
    if (seg.inString) {
      out += seg.text
    } else {
      let t = seg.text
      for (const [re, repl] of replacements) {
        // 全局正则（带 g flag）可直接 replace；不带 g 的也安全（仅替换首个，不影响）。
        t = t.replace(re, repl)
      }
      out += t
    }
  }
  return out
}

/**
 * 按括号深度补全截断的 JSON（缺末尾右括号时追加 `}`/`]`）。
 *
 * 扫描字符串（绕开字符串内容），统计 `{`/`[` 与 `}`/`]` 的深度栈。
 * 结束时栈中残留的左括号按入栈逆序追加对应右括号。
 *
 * 仅处理「以 { 或 [ 开头」的文本（repairLLMJson 已守卫），且对已配对的 JSON 无副作用
 * （栈空 → 追加 0 字符）。
 *
 * @param text 待补全的 JSON 文本
 * @returns 补全右括号后的文本
 */
function repairTruncated(text: string): string {
  const stack: Array<'{' | '['> = []
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) {
        i += 1
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}') {
      // 弹出到最近的 `{`（容忍轻微错位）
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j] === '{') {
          stack.splice(j, 1)
          break
        }
      }
    } else if (ch === ']') {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j] === '[') {
          stack.splice(j, 1)
          break
        }
      }
    }
  }
  if (stack.length === 0) return text
  // 按入栈逆序追加右括号（栈顶是最后入栈的，最先补）
  let suffix = ''
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += stack[i] === '{' ? '}' : ']'
  }
  return text + suffix
}

/**
 * 解析 LLM 结构化 JSON 输出并严格校验。
 *
 * 流程：剥离 fence → Bug B 修复链（标点/逗号/截断）→ JSON.parse → ajv 校验 → 返回强类型 T。
 * **任一步骤失败 throw（绝不伪造兜底）**——由上层规则引擎降级。
 *
 * Bug B 修复（2026-06）：LLM 输出常含中文标点 / trailing comma / 截断右括号，
 * 导致 `JSON.parse` 失败 → 规则引擎兜底（无叙事润色）。修复链在 parse 前清洗文本，
 * 尽量走真 LLM 路径；修复后仍解析失败则按原行为抛 LlmJsonParseError。
 *
 * @param text LLM 原始输出文本
 * @param validate ajv 校验函数（用 compileSchema 或自备）
 * @returns 解析并校验通过的对象（类型 T）
 * @throws LlmJsonParseError 解析或校验失败（含 ajv errors 详情 + 原始文本片段）
 */
export function parseLLMJson<T>(
  text: string,
  validate: ValidateFunction<T>,
): T {
  const stripped = stripMarkdownFence(text)

  // Bug B：修复链尝试。先尝试原文 JSON.parse（最快路径，绝大多数 LLM 输出本就合法）；
  // 失败则应用 repairLLMJson 后重试。
  let parsed: unknown
  let usedRepair = false
  let parseErr: unknown = null
  try {
    parsed = JSON.parse(stripped)
  } catch (e) {
    parseErr = e
    // 应用修复链重试
    const repaired = repairLLMJson(stripped)
    if (repaired !== stripped) {
      try {
        parsed = JSON.parse(repaired)
        usedRepair = true
        parseErr = null
      } catch (e2) {
        parseErr = e2
      }
    }
  }
  if (parseErr !== null) {
    throw new LlmJsonParseError(
      `LLM 输出 JSON.parse 失败: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      null,
    )
  }
  void usedRepair // 仅供调试/日志用（避免 unused 警告）

  if (!validate(parsed)) {
    // 校验失败：绝不伪造，抛错让上层降级
    throw new LlmJsonParseError(
      'LLM 输出未通过 ajv schema 校验',
      (validate.errors ?? null) as Array<Record<string, unknown>> | null,
    )
  }

  return parsed
}

/**
 * 编译并缓存某 schema 的 ajv ValidateFunction。
 *
 * 同一 schemaKey 只编译一次（编译是 O(n) 成本，校验是 O(n)）。
 *
 * @param schemaKey 缓存键（如 'chief'/'theater'）
 * @param schema JSON Schema 对象
 * @param ajv 可选自定义 ajv 实例（默认用单例）
 */
const _compiledCache = new Map<string, ValidateFunction>()
export function compileSchema(
  schemaKey: string,
  schema: object,
  ajv?: Ajv,
): ValidateFunction {
  const cached = _compiledCache.get(schemaKey)
  if (cached) return cached
  const instance = ajv ?? defaultAjv()
  const compiled = instance.compile(schema) as ValidateFunction
  _compiledCache.set(schemaKey, compiled)
  return compiled
}

/**
 * 便捷：按角色名取已编译的 ValidateFunction。
 * 四类 Agent schema 在 import 时预编译（首次调用）。
 */
export function getAgentValidator(
  role: 'chief' | 'theater' | 'commander' | 'director',
  ajv?: Ajv,
): ValidateFunction {
  return compileSchema(role, AGENT_OUTPUT_SCHEMAS[role], ajv)
}

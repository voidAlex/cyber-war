/**
 * 生成器输出 JSON Schema + 上下文构造（generator-context.ts）— 纯函数边界。
 *
 * 职责：
 * - 定义 researcher / balancer 的输出 JSON Schema（designer 输出即 CampaignPayload，
 *   由 campaign-zip 的 validateCampaignPayload 校验，此处不重复）。
 * - buildGeneratorMessages：按 L0 共享前缀 + L3 玩家需求构造 messages（缓存友好）。
 *
 * 缓存分层（与 context-builder 一致理念）：
 * - L0：人格 + 共享三段（七文件 schema/生成规则/历史校验规则）+ 角色 schema 尾段（固定）。
 * - L3：玩家需求 / 设计师任务 / 校验任务（每请求变，回合号/随机只放这里）。
 *
 * 纯函数：不调 Tauri/fetch/crypto/Date.now/random。
 *
 * @module layers/agents/generator/generator-schema
 */

import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import type { AgentMessage } from '@/types'
import {
  buildGeneratorL0,
  type GeneratorRole,
} from './prefix'
import {
  RESEARCHER_OUTPUT_SCHEMA_TEXT,
  BALANCER_OUTPUT_SCHEMA_TEXT,
} from './shared-text'

// =============================================================================
// 研究员输出 JSON Schema（draft-07）
// =============================================================================

/** 研究员事实条目（claim + 存疑标注） */
export const RESEARCHER_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'generator-output/researcher',
  title: 'ResearcherOutput',
  type: 'object',
  properties: {
    /** 是否真实战役（false=虚构/架空/自定义） */
    historical: { type: 'boolean' },
    /** 战役名 */
    name: { type: 'string', minLength: 1 },
    /** 时间段 */
    timePeriod: { type: 'string', minLength: 1 },
    /** 双方阵营 */
    factions: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          side: {
            type: 'string',
            enum: ['player', 'enemy', 'ally', 'neutral'],
          },
          brief: { type: 'string', minLength: 1 },
        },
        required: ['id', 'name', 'side', 'brief'],
        additionalProperties: false,
      },
    },
    /** 指挥官（含人格倾向） */
    commanders: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          factionId: { type: 'string', minLength: 1 },
          rank: { type: 'string' },
          aggression: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
          },
          obedience: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
          },
          tempo: {
            type: 'string',
            enum: ['methodical', 'balanced', 'rapid'],
          },
          brief: { type: 'string', minLength: 1 },
        },
        required: ['name', 'factionId', 'aggression', 'obedience', 'tempo', 'brief'],
        additionalProperties: false,
      },
    },
    /** 地理 */
    geography: {
      type: 'object',
      properties: {
        riversOrBarriers: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
        },
        fortressesOrObjectives: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1 },
              brief: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        terrainSummary: { type: 'string', minLength: 1 },
      },
      required: ['fortressesOrObjectives', 'terrainSummary'],
      additionalProperties: false,
    },
    /** 兵力规模 */
    forceScale: {
      type: 'object',
      properties: {
        sideApprox: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              factionId: { type: 'string', minLength: 1 },
              personnelApprox: { type: 'string', minLength: 1 },
            },
            required: ['factionId', 'personnelApprox'],
            additionalProperties: false,
          },
        },
      },
      required: ['sideApprox'],
      additionalProperties: false,
    },
    /** 关键事件 */
    keyEvents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phase: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
        },
        required: ['phase', 'description'],
        additionalProperties: false,
      },
    },
    /** 胜负结局 */
    outcome: { type: 'string', minLength: 1 },
    /** 关键事实 + 存疑标注 */
    facts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', minLength: 1 },
          isUncertain: { type: 'boolean' },
        },
        required: ['claim', 'isUncertain'],
        additionalProperties: false,
      },
    },
    /** 提示玩家核对/虚构说明 */
    notes: { type: 'string', minLength: 1 },
  },
  required: [
    'historical',
    'name',
    'timePeriod',
    'factions',
    'commanders',
    'geography',
    'forceScale',
    'outcome',
    'facts',
    'notes',
  ],
  additionalProperties: false,
} as const

/** 研究员输出 TS 类型 */
export interface ResearcherFact {
  claim: string
  isUncertain: boolean
}
export interface ResearcherFaction {
  id: string
  name: string
  side: 'player' | 'enemy' | 'ally' | 'neutral'
  brief: string
}
export interface ResearcherCommander {
  name: string
  factionId: string
  rank?: string
  aggression: 'low' | 'medium' | 'high'
  obedience: 'low' | 'medium' | 'high'
  tempo: 'methodical' | 'balanced' | 'rapid'
  brief: string
}
export interface ResearcherOutput {
  historical: boolean
  name: string
  timePeriod: string
  factions: ResearcherFaction[]
  commanders: ResearcherCommander[]
  geography: {
    riversOrBarriers?: string[]
    fortressesOrObjectives: Array<{ name: string; brief?: string }>
    terrainSummary: string
  }
  forceScale: {
    sideApprox: Array<{ factionId: string; personnelApprox: string }>
  }
  keyEvents?: Array<{ phase: string; description: string }>
  outcome: string
  facts: ResearcherFact[]
  notes: string
}

// =============================================================================
// 平衡校验输出 JSON Schema（draft-07）
// =============================================================================

export const BALANCER_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'generator-output/balancer',
  title: 'BalancerOutput',
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', minLength: 1 },
          problem: { type: 'string', minLength: 1 },
        },
        required: ['field', 'problem'],
        additionalProperties: false,
      },
    },
    suggestions: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['pass'],
  additionalProperties: false,
} as const

/** 平衡校验输出 TS 类型 */
export interface BalancerIssue {
  field: string
  problem: string
}
export interface BalancerOutput {
  pass: boolean
  issues?: BalancerIssue[]
  suggestions?: string[]
}

// =============================================================================
// ajv 校验器（编译缓存，供 roles + 编排复用）
// =============================================================================

let _ajv: Ajv | null = null
function defaultAjv(): Ajv {
  if (!_ajv) {
    _ajv = new Ajv({ allErrors: true, strict: true })
    addFormats(_ajv)
  }
  return _ajv
}

const _compiled = new Map<string, ValidateFunction>()

/**
 * 取某生成器角色输出 schema 的已编译校验器（编译缓存）。
 * @template T 输出类型（researcher→ResearcherOutput，balancer→BalancerOutput）
 */
export function getGeneratorValidator<T extends ResearcherOutput | BalancerOutput>(
  role: 'researcher' | 'balancer',
  ajv?: Ajv,
): ValidateFunction<T> {
  const cached = _compiled.get(role)
  if (cached) return cached as ValidateFunction<T>
  const schema =
    role === 'researcher' ? RESEARCHER_OUTPUT_SCHEMA : BALANCER_OUTPUT_SCHEMA
  const compiled = (ajv ?? defaultAjv()).compile(schema) as ValidateFunction<T>
  _compiled.set(role, compiled as unknown as ValidateFunction)
  return compiled
}

// =============================================================================
// 角色 schema 尾段（L0 末段，固定）— 仅该角色需要
// =============================================================================

/** 研究员的输出 schema 尾段（L0 末段） */
export const RESEARCHER_SCHEMA_MESSAGE: AgentMessage = {
  role: 'system',
  content: RESEARCHER_OUTPUT_SCHEMA_TEXT,
}

/** 平衡校验的输出 schema 尾段（L0 末段） */
export const BALANCER_SCHEMA_MESSAGE: AgentMessage = {
  role: 'system',
  content: BALANCER_OUTPUT_SCHEMA_TEXT,
}

// =============================================================================
// buildGeneratorMessages：L0 共享前缀 + 角色 schema 尾段 + L3 任务
// =============================================================================

/**
 * 构造生成器 Agent 的 messages（缓存友好）。
 *
 * 顺序（稳定→易变）：
 * 1. L0 人格 + 共享三段（buildGeneratorL0，三 Agent 一致 → 跨 Agent 命中）。
 * 2. 角色 schema 尾段（researcher/balancer 各自固定；designer 用七文件 schema 已在共享段）。
 * 3. L3 任务（玩家需求 / 设计师任务 / 校验任务，每请求变，回合号只放这里）。
 *
 * @param role 生成器 Agent 角色
 * @param task L3 本条任务文本
 * @returns 分层 messages
 */
export function buildGeneratorMessages(
  role: GeneratorRole,
  task: string,
): AgentMessage[] {
  const messages: AgentMessage[] = buildGeneratorL0(role)

  // 角色 schema 尾段（designer 无独立尾段，其 schema 即共享的七文件 schema）
  if (role === 'researcher') {
    messages.push(RESEARCHER_SCHEMA_MESSAGE)
  } else if (role === 'balancer') {
    messages.push(BALANCER_SCHEMA_MESSAGE)
  }

  // L3 任务（玩家需求等易变内容只放这里）
  messages.push({ role: 'user', content: task })

  return messages
}

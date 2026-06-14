/**
 * 战役生成器编排测试（generator.test.ts）— M4-C。
 *
 * 验证（doc/tech-design-v1.0.md §3.11 + doc/prd-v1.0.md §7.1）：
 * 1. 编排 happy path：mock LLM 跑完 researcher→designer→balancer→schema 校验通过。
 * 2. schema 失败 → 多次后降级模板包（绝不伪造非法 payload）。
 * 3. 缓存前缀：固定 L0 前缀（三 Agent 共享，字节级稳定）。
 * 4. 虚构标注：historical=false → warnings 含「非史实」。
 * 5. 存疑标注：facts.isUncertain → warnings 含「存疑事实」。
 *
 * LLM 用 mock（注入伪造 LlmService，按 task 内容路由不同响应）。
 *
 * @module __tests__/agents/generator
 */

import { describe, it, expect } from 'vitest'
import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from '@/layers/agents/roles/llm-role-base'
import type {
  StreamChatOptions,
  StreamChatResult,
  StreamChatStats,
} from '@/layers/gateway/llm-client'
import type { ValidateFunction } from 'ajv'
import {
  generateCampaign,
  MAX_DESIGNER_RETRIES,
} from '@/layers/agents/generator'
import {
  buildGeneratorL0,
  buildGeneratorMessages,
  SCHEMA_DEFINITION_MESSAGE,
  GENERATION_RULES_MESSAGE,
  HISTORY_CHECK_RULES_MESSAGE,
} from '@/layers/agents/generator'
import { validateCampaignPayload } from '@/layers/persistence/campaign-zip'
import { verdunCampaign } from '@/data/verdun-1916'
import type { CampaignPayload } from '@/types'

const CFG: LlmCallConfig = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-v4-flash',
  apiKey: 'k',
}

const ZERO_STATS: StreamChatStats = {
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  degraded: false,
}

// =============================================================================
// mock LlmService：按 task 关键字路由不同响应
// =============================================================================

interface MockRoute {
  /** 匹配关键字（在 user message content 中查找） */
  match: string
  /** 返回的文本（LLM 原始输出）；可为函数（按调用次数动态生成） */
  respond: string | (() => string)
}

/**
 * 构造 mock LlmService：按 messages 末条 user content 匹配 route.respond。
 * researcher/balancer 走 streamChatStructured（需 ajv 校验），designer 走 streamText。
 */
function makeMockLlmService(routes: MockRoute[]): LlmService {
  const findResponse = (messages: Array<{ role: string; content: string }>): string => {
    const last = [...messages].reverse().find((m) => m.role === 'user')
    const content = last?.content ?? ''
    for (const r of routes) {
      if (content.includes(r.match)) {
        return typeof r.respond === 'function' ? r.respond() : r.respond
      }
    }
    throw new Error(`mock LlmService 无匹配 route（content 末段: ${content.slice(-80)}）`)
  }

  return {
    async streamText(opts: StreamChatOptions): Promise<StreamChatResult> {
      return { text: findResponse(opts.messages), stats: ZERO_STATS }
    },
    async streamTextWithDeltas(opts: StreamChatOptions): Promise<StreamChatResult> {
      return { text: findResponse(opts.messages), stats: ZERO_STATS }
    },
    async streamChatStructured<T>(
      opts: StreamChatOptions,
      validate: ValidateFunction<T>,
    ): Promise<{ data: T; stats: StreamChatStats }> {
      const text = findResponse(opts.messages)
      // 剥离 fence + parse + 校验（与 llm-service 实现一致）
      const stripped = text.replace(/^```(?:json)?\s*\n?|\n?```\s*$/g, '').trim()
      const parsed = JSON.parse(stripped) as T
      if (!validate(parsed)) {
        throw new Error('mock streamChatStructured ajv 校验失败')
      }
      return { data: parsed, stats: ZERO_STATS }
    },
    getCacheStats() {
      return {
        totalHitTokens: 0,
        totalMissTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        callCount: 0,
        degradedCount: 0,
      }
    },
    resetCacheStats() {},
  }
}

// =============================================================================
// 固定 mock 响应文本
// =============================================================================

/** 真实战役研究员输出（库尔斯克会战） */
const RESEARCHER_REAL = JSON.stringify({
  historical: true,
  name: '库尔斯克会战',
  timePeriod: '1943-07-05 ~ 1943-08-23',
  factions: [
    { id: 'soviet', name: '苏联红军', side: 'player', brief: '防御方' },
    { id: 'german', name: '德意志国防军', side: 'enemy', brief: '进攻方' },
  ],
  commanders: [
    {
      name: '朱可夫',
      factionId: 'soviet',
      aggression: 'high',
      obedience: 'high',
      tempo: 'balanced',
      brief: '苏军统帅',
    },
    {
      name: '曼施坦因',
      factionId: 'german',
      aggression: 'high',
      obedience: 'medium',
      tempo: 'rapid',
      brief: '德军南方集团军群',
    },
  ],
  geography: {
    riversOrBarriers: ['顿涅茨河'],
    fortressesOrObjectives: [{ name: '库尔斯克突出部', brief: '战役核心' }],
    terrainSummary: '东欧平原，突出部地形',
  },
  forceScale: {
    sideApprox: [
      { factionId: 'soviet', personnelApprox: '约 190 万' },
      { factionId: 'german', personnelApprox: '约 90 万' },
    ],
  },
  keyEvents: [{ phase: '初期', description: '德军装甲突击被苏军纵深防御遏制' }],
  outcome: '苏军防御成功，德军攻势受挫',
  facts: [
    { claim: '史上最大坦克会战', isUncertain: false },
    { claim: '苏军兵力约 190 万（不同来源有出入）', isUncertain: true },
  ],
  notes: '著名战役，史实较可靠；兵力数字不同来源有出入，已标存疑。',
})

/** 虚构战役研究员输出 */
const RESEARCHER_FICTIONAL = JSON.stringify({
  historical: false,
  name: '海岛攻防',
  timePeriod: '架空',
  factions: [
    { id: 'blue', name: '蓝方', side: 'player', brief: '登陆方' },
    { id: 'red', name: '红方', side: 'enemy', brief: '守岛方' },
  ],
  commanders: [
    {
      name: '蓝方统帅',
      factionId: 'blue',
      aggression: 'medium',
      obedience: 'high',
      tempo: 'balanced',
      brief: '虚构',
    },
    {
      name: '红方统帅',
      factionId: 'red',
      aggression: 'low',
      obedience: 'medium',
      tempo: 'methodical',
      brief: '虚构',
    },
  ],
  geography: {
    fortressesOrObjectives: [{ name: '中央高地', brief: '虚构' }],
    terrainSummary: '海岛地形',
  },
  forceScale: {
    sideApprox: [
      { factionId: 'blue', personnelApprox: '约 5 万' },
      { factionId: 'red', personnelApprox: '约 5 万' },
    ],
  },
  outcome: '待定',
  facts: [{ claim: '虚构战役，非史实', isUncertain: true }],
  notes: '非史实·虚构：玩家自定义海岛攻防。',
})

/**
 * 构造合法 designer 输出（基于 verdun 结构改 scenarioId/name）。
 * 保证 schema 一定通过（复用 verdun 七文件，仅改 manifest 元信息）。
 */
function legalDesignerOutput(name: string): string {
  const payload: CampaignPayload = {
    ...verdunCampaign,
    manifest: {
      ...verdunCampaign.manifest,
      scenarioId: 'generated-test',
      displayName: name,
      scenarioSeed: '', // 由编排注入
    },
  }
  return '```json\n' + JSON.stringify(payload) + '\n```'
}

/** 非法 designer 输出（缺 units，schema 必失败） */
const ILLEGAL_DESIGNER_OUTPUT = JSON.stringify({
  ...verdunCampaign,
  units: [], // schema minItems:1 失败
})

/** balancer 通过 */
const BALANCER_PASS = JSON.stringify({ pass: true, issues: [], suggestions: [] })

// =============================================================================
// 测试
// =============================================================================

describe('generateCampaign — 编排 happy path', () => {
  it('researcher→designer→balancer→schema 校验通过，产物合法且非降级', async () => {
    const llm = makeMockLlmService([
      { match: '玩家需求（L3', respond: '```json\n' + RESEARCHER_REAL + '\n```' },
      { match: '史实依据，JSON', respond: legalDesignerOutput('库尔斯克会战') },
      { match: '史实对照，JSON', respond: BALANCER_PASS },
    ])

    const res = await generateCampaign(
      { playerRequest: '库尔斯克会战' },
      llm,
      CFG,
    )

    // 产物必 schema 合法（绝不输出非法 payload）
    expect(() => validateCampaignPayload(res.payload)).not.toThrow()
    expect(res.degraded).toBe(false)
    // 研究员产出回传
    expect(res.research.historical).toBe(true)
    expect(res.research.name).toBe('库尔斯克会战')
    // 注入了固定 scenarioSeed
    expect(res.payload.manifest.scenarioSeed.length).toBeGreaterThan(0)
    // 存疑事实 → warnings
    expect(res.warnings.some((w) => w.includes('存疑事实'))).toBe(true)
  })

  it('阶段进度回调按顺序触发', async () => {
    const llm = makeMockLlmService([
      { match: '玩家需求（L3', respond: '```json\n' + RESEARCHER_REAL + '\n```' },
      { match: '史实依据，JSON', respond: legalDesignerOutput('库尔斯克会战') },
      { match: '史实对照，JSON', respond: BALANCER_PASS },
    ])
    const stages: string[] = []
    await generateCampaign(
      { playerRequest: '库尔斯克会战' },
      llm,
      CFG,
      (stage) => stages.push(stage),
    )
    // 至少经历 researcher → designer → schema-validate → balancer → done
    expect(stages[0]).toBe('researcher')
    expect(stages).toContain('designer')
    expect(stages).toContain('schema-validate')
    expect(stages).toContain('balancer')
    expect(stages[stages.length - 1]).toBe('done')
  })
})

describe('generateCampaign — schema 失败 → 降级模板包', () => {
  it('设计师始终输出非法 payload → 降级模板包（合法 + degraded=true）', async () => {
    const llm = makeMockLlmService([
      { match: '玩家需求（L3', respond: '```json\n' + RESEARCHER_REAL + '\n```' },
      // designer 永远返回非法（缺 units）
      { match: '史实依据，JSON', respond: '```json\n' + ILLEGAL_DESIGNER_OUTPUT + '\n```' },
    ])

    const res = await generateCampaign(
      { playerRequest: '库尔斯克会战' },
      llm,
      CFG,
    )

    // 降级为模板包
    expect(res.degraded).toBe(true)
    // 模板包必 schema 合法（绝不伪造非法数据）
    expect(() => validateCampaignPayload(res.payload)).not.toThrow()
    // warnings 含降级说明
    expect(res.warnings.some((w) => w.includes('降级'))).toBe(true)
    // 经历了 MAX_DESIGNER_RETRIES+1 次设计师尝试（首轮 + 重试）
    const designerAttempts = res.warnings.filter((w) =>
      w.includes('schema 校验失败'),
    ).length
    expect(designerAttempts).toBe(MAX_DESIGNER_RETRIES + 1)
  })
})

describe('generateCampaign — 虚构/非史实标注', () => {
  it('historical=false → warnings 含「非史实」', async () => {
    const llm = makeMockLlmService([
      { match: '玩家需求（L3', respond: '```json\n' + RESEARCHER_FICTIONAL + '\n```' },
      { match: '史实依据，JSON', respond: legalDesignerOutput('海岛攻防') },
      { match: '史实对照，JSON', respond: BALANCER_PASS },
    ])

    const res = await generateCampaign(
      { playerRequest: '两方均衡海岛攻防' },
      llm,
      CFG,
    )

    expect(res.research.historical).toBe(false)
    expect(res.warnings.some((w) => w.includes('非史实'))).toBe(true)
    // 虚构事实也标存疑
    expect(res.warnings.some((w) => w.includes('存疑'))).toBe(true)
  })
})

describe('generateCampaign — balancer 迭代', () => {
  it('balancer 不通过 → 反馈设计师修正，达 MAX_BALANCE_RETRIES 后采用最新草案', async () => {
    const balancerFail = JSON.stringify({
      pass: false,
      issues: [{ field: 'units', problem: '兵力悬殊' }],
      suggestions: ['调整兵力'],
    })
    let designerCallCount = 0
    const llm = makeMockLlmService([
      { match: '玩家需求（L3', respond: '```json\n' + RESEARCHER_REAL + '\n```' },
      {
        match: '史实依据，JSON',
        respond: () => {
          designerCallCount++
          return legalDesignerOutput('库尔斯克会战')
        },
      },
      { match: '史实对照，JSON', respond: balancerFail },
    ])

    const res = await generateCampaign(
      { playerRequest: '库尔斯克会战' },
      llm,
      CFG,
    )

    // balancer 始终不通过 → warnings 含未通过说明
    expect(res.warnings.some((w) => w.includes('平衡校验多次未通过'))).toBe(true)
    // 仍产出合法 payload
    expect(() => validateCampaignPayload(res.payload)).not.toThrow()
    expect(res.degraded).toBe(false)
    // designer 被多次调用（首轮 + balancer 反馈迭代）
    expect(designerCallCount).toBeGreaterThanOrEqual(1 + 1)
  })
})

describe('缓存前缀 — 固定 L0', () => {
  it('三 Agent 的 L0 前缀（人格除外）字节级一致：七文件 schema/生成规则/历史校验规则', () => {
    const researcherL0 = buildGeneratorL0('researcher')
    const designerL0 = buildGeneratorL0('designer')
    const balancerL0 = buildGeneratorL0('balancer')

    // L0 = [人格, 七文件schema, 生成规则, 历史校验规则]
    // 后三段三 Agent 完全一致（缓存命中基础）
    expect(researcherL0[1]).toBe(SCHEMA_DEFINITION_MESSAGE)
    expect(designerL0[1]).toBe(SCHEMA_DEFINITION_MESSAGE)
    expect(balancerL0[1]).toBe(SCHEMA_DEFINITION_MESSAGE)

    expect(researcherL0[2]).toBe(GENERATION_RULES_MESSAGE)
    expect(designerL0[2]).toBe(GENERATION_RULES_MESSAGE)
    expect(balancerL0[2]).toBe(GENERATION_RULES_MESSAGE)

    expect(researcherL0[3]).toBe(HISTORY_CHECK_RULES_MESSAGE)
    expect(designerL0[3]).toBe(HISTORY_CHECK_RULES_MESSAGE)
    expect(balancerL0[3]).toBe(HISTORY_CHECK_RULES_MESSAGE)

    // 仅人格段（index 0）不同
    expect(researcherL0[0]).not.toBe(designerL0[0])
    expect(designerL0[0]).not.toBe(balancerL0[0])
  })

  it('buildGeneratorMessages：玩家需求只出现在 L3 末条 user，L0 前缀不含易变内容', () => {
    const msgs = buildGeneratorMessages('researcher', '玩家需求：库尔斯克会战')
    // L0 段（前 4 条 system）不含「库尔斯克」（玩家需求）
    const l0Text = msgs.slice(0, 4).map((m) => m.content).join('')
    expect(l0Text).not.toContain('库尔斯克')
    // L3 末条 user 含玩家需求
    const last = msgs[msgs.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('库尔斯克')
  })

  it('L0 前缀禁止含时间戳/UUID/动态回合号类易变标记', () => {
    const l0 = buildGeneratorL0('designer').map((m) => m.content).join('')
    // 这些易变模式不应出现在固定 L0 中
    expect(l0).not.toMatch(/\b\d{4}-\d{2}-\d{2}T/) // ISO 时间戳
    expect(l0).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/) // UUID
  })
})

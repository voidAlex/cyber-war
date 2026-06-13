/**
 * parseLLMJson + schema 纯函数测试（parse-llm-json.test.ts）。
 *
 * 覆盖：
 * - stripMarkdownFence：```json fence / 无标签 fence / 纯 JSON / 含解释文本。
 * - parseLLMJson：fence 剥离后校验通过 / 校验失败 throw / JSON.parse 失败 throw。
 * - 不伪造：校验失败时绝不返回兜底对象（必须 throw）。
 * - 四类 Agent schema 编译与校验。
 *
 * 纯函数：不调 Tauri/fetch。
 *
 * @module __tests__/agents/parse-llm-json
 */

import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import {
  parseLLMJson,
  stripMarkdownFence,
  compileSchema,
  getAgentValidator,
  createAjv,
  CHIEF_OUTPUT_SCHEMA,
  LlmJsonParseError,
} from '@/layers/agents/protocol/schema'
import type { ChiefAgentOutput } from '@/layers/agents/protocol/schema'
import type { ValidateFunction } from 'ajv'

// =============================================================================
// stripMarkdownFence
// =============================================================================

describe('stripMarkdownFence', () => {
  it('剥离 ```json fence', () => {
    const raw = '```json\n{"a":1}\n```'
    expect(stripMarkdownFence(raw)).toBe('{"a":1}')
  })

  it('剥离无语言标签的 ``` fence', () => {
    const raw = '```\n{"a":1}\n```'
    expect(stripMarkdownFence(raw)).toBe('{"a":1}')
  })

  it('纯 JSON（无 fence）原样返回', () => {
    expect(stripMarkdownFence('{"a":1}')).toBe('{"a":1}')
  })

  it('fence 前后有解释文本：取 fence 内容', () => {
    const raw = '好的，这是结果：\n```json\n{"a":1}\n```\n以上。'
    expect(stripMarkdownFence(raw)).toBe('{"a":1}')
  })

  it('无 fence 但首尾有解释文本：取首 { 到尾 }', () => {
    const raw = '解析结果如下： {"a":1} 完成'
    expect(stripMarkdownFence(raw)).toBe('{"a":1}')
  })

  it('大写 JSON 标签也能剥离', () => {
    const raw = '```JSON\n{"a":1}\n```'
    expect(stripMarkdownFence(raw)).toBe('{"a":1}')
  })

  it('空字符串返回空', () => {
    expect(stripMarkdownFence('')).toBe('')
  })
})

// =============================================================================
// parseLLMJson：成功 / 失败 / 不伪造
// =============================================================================

describe('parseLLMJson', () => {
  const ajv = createAjv()
  const validate = compileSchema('test-chief', CHIEF_OUTPUT_SCHEMA, ajv)

  it('合法 chief 输出（带 fence）解析并校验通过', () => {
    const raw = '```json\n{"candidates":[{"intent":"move","unitIds":["u-1"],"summary":"移动","confidence":0.9}]}\n```'
    const data = parseLLMJson<ChiefAgentOutput>(raw, validate as ValidateFunction<ChiefAgentOutput>)
    expect(data.candidates).toHaveLength(1)
    expect(data.candidates[0].intent).toBe('move')
    expect(data.candidates[0].unitIds).toContain('u-1')
    expect(data.candidates[0].confidence).toBeCloseTo(0.9)
  })

  it('JSON.parse 失败时 throw（不伪造）', () => {
    expect(() => parseLLMJson('不是 JSON', validate as ValidateFunction)).toThrow(
      LlmJsonParseError,
    )
  })

  it('schema 校验失败时 throw（绝不伪造兜底）', () => {
    // 缺 required 字段 intent
    const raw = '{"candidates":[{"unitIds":["u-1"],"summary":"x","confidence":0.5}]}'
    expect(() => parseLLMJson(raw, validate as ValidateFunction)).toThrow(
      LlmJsonParseError,
    )
  })

  it('candidates 空数组（minItems:1）校验失败 throw', () => {
    const raw = '{"candidates":[]}'
    expect(() => parseLLMJson(raw, validate as ValidateFunction)).toThrow(
      LlmJsonParseError,
    )
  })

  it('校验失败的 error 含 ajv errors 详情', () => {
    const raw = '{"candidates":[]}'
    try {
      parseLLMJson(raw, validate as ValidateFunction)
      expect.fail('应 throw')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmJsonParseError)
      const err = e as LlmJsonParseError
      expect(err.errors).not.toBeNull()
    }
  })

  it('intent 非法枚举值校验失败', () => {
    const raw = '{"candidates":[{"intent":"teleport","unitIds":["u-1"],"summary":"x","confidence":0.5}]}'
    expect(() => parseLLMJson(raw, validate as ValidateFunction)).toThrow(
      LlmJsonParseError,
    )
  })

  it('confidence 越界（>1）校验失败', () => {
    const raw = '{"candidates":[{"intent":"move","unitIds":["u-1"],"summary":"x","confidence":1.5}]}'
    expect(() => parseLLMJson(raw, validate as ValidateFunction)).toThrow(
      LlmJsonParseError,
    )
  })
})

// =============================================================================
// 四类 Agent schema 编译
// =============================================================================

describe('getAgentValidator — 四类 Agent schema', () => {
  it('chief schema 编译且校验合法输出', () => {
    const v = getAgentValidator('chief') as ValidateFunction
    expect(v({ candidates: [{ intent: 'hold', unitIds: ['u-1'], summary: 's', confidence: 0.1 }] })).toBe(true)
  })

  it('theater schema 编译且校验合法输出', () => {
    const v = getAgentValidator('theater') as ValidateFunction
    expect(v({ actions: [{ unitId: 'u-1', intent: 'move', targetCoord: { col: 1, row: 2 } }] })).toBe(true)
  })

  it('commander schema 编译且校验合法输出', () => {
    const v = getAgentValidator('commander') as ValidateFunction
    expect(v({ decisions: [{ unitId: 'u-1', intent: 'attack', rationale: 'r' }] })).toBe(true)
  })

  it('director schema 编译且校验合法输出', () => {
    const v = getAgentValidator('director') as ValidateFunction
    expect(v({ reportText: '战报', overrides: [{ field: 'f', before: 1, after: 2, reason: 'r' }] })).toBe(true)
  })

  it('director 缺 reportText 校验失败', () => {
    const v = getAgentValidator('director') as ValidateFunction
    expect(v({ overrides: [] })).toBe(false)
  })

  it('compileSchema 缓存：同 key 返回同一函数', () => {
    const ajv = new Ajv({ strict: false })
    const v1 = compileSchema('cache-test', { type: 'object' }, ajv)
    const v2 = compileSchema('cache-test', { type: 'object' }, ajv)
    expect(v1).toBe(v2)
  })
})

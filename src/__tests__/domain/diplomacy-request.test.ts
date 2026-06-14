/**
 * 外交请求流程（diplomacy-request）单测。
 *
 * 验证：resolveDiplomaticResponse（accept/reject/flake → 信任度变化）、
 * rollDiplomaticResponse（信任度概率）、请求类别推断。
 *
 * @module __tests__/domain/diplomacy-request
 */

import { describe, expect, it } from 'vitest'
import {
  resolveDiplomaticResponse,
  rollDiplomaticResponse,
  inferRequestKind,
  describeRequestKind,
  describeResponseType,
  responseColor,
  applyDiplomacyResultToFaction,
  HONOR_DELTA,
  BREAK_DELTA,
  type DiplomaticRequest,
  type DiplomaticResponse,
  type DiplomaticResponseType,
} from '@/layers/domain/diplomacy-request'
import type { DiplomacyTrust, Faction } from '@/types'

/** 构造信任度记录 */
function makeTrust(overrides: Partial<DiplomacyTrust> = {}): DiplomacyTrust {
  return {
    trust: 60,
    stance: 'ally',
    honoredCount: 0,
    brokenCount: 0,
    lastChangeTurn: 0,
    ...overrides,
  }
}

/** 构造请求 */
function makeRequest(overrides: Partial<DiplomaticRequest> = {}): DiplomaticRequest {
  return {
    turn: 5,
    fromFactionId: 'blue',
    toFactionId: 'green',
    kind: 'air_support',
    text: '请求空中支援',
    ...overrides,
  }
}

/** 构造响应 */
function makeResponse(
  overrides: Partial<DiplomaticResponse> & { request?: DiplomaticRequest } = {},
): DiplomaticResponse {
  const request = overrides.request ?? makeRequest()
  return {
    request,
    type: 'accept',
    message: '同意',
    disobeying: false,
    ...overrides,
  }
}

describe('resolveDiplomaticResponse', () => {
  it('accept → 履约 +8', () => {
    const trust = makeTrust({ trust: 60 })
    const result = resolveDiplomaticResponse(trust, makeResponse({ type: 'accept' }))
    expect(result.delta).toBe(HONOR_DELTA)
    expect(result.trustAfter.trust).toBe(68)
    expect(result.trustAfter.honoredCount).toBe(1)
    expect(result.event.kind).toBe('honor')
    expect(result.defectionRisk).toBe(false)
  })

  it('flake → 毁约 -20', () => {
    const trust = makeTrust({ trust: 60 })
    const result = resolveDiplomaticResponse(trust, makeResponse({ type: 'flake' }))
    expect(result.delta).toBe(BREAK_DELTA)
    expect(result.trustAfter.trust).toBe(40)
    expect(result.trustAfter.brokenCount).toBe(1)
    expect(result.event.kind).toBe('break')
  })

  it('reject → 信任度不变（delta=0）', () => {
    const trust = makeTrust({ trust: 60 })
    const result = resolveDiplomaticResponse(trust, makeResponse({ type: 'reject' }))
    expect(result.delta).toBe(0)
    expect(result.trustAfter.trust).toBe(60)
    expect(result.trustAfter.honoredCount).toBe(0)
    expect(result.trustAfter.brokenCount).toBe(0)
  })

  it('flake 致信任度 <15 → 倒戈风险标记', () => {
    const trust = makeTrust({ trust: 10 })
    const result = resolveDiplomaticResponse(trust, makeResponse({ type: 'flake' }))
    expect(result.trustAfter.trust).toBe(0) // 钳制
    expect(result.defectionRisk).toBe(true)
  })

  it('信任度钳制 [0,100]', () => {
    const trust = makeTrust({ trust: 5 })
    const result = resolveDiplomaticResponse(trust, makeResponse({ type: 'flake' }))
    expect(result.trustAfter.trust).toBeGreaterThanOrEqual(0)
  })

  it('event 记录变动后信任度', () => {
    const trust = makeTrust({ trust: 60 })
    const result = resolveDiplomaticResponse(trust, makeResponse({ type: 'accept' }))
    expect(result.event.trustAfter).toBe(68)
    expect(result.event.delta).toBe(HONOR_DELTA)
  })
})

describe('rollDiplomaticResponse', () => {
  it('信任度极低 + rand=0 → reject（拒绝率近 1）', () => {
    expect(rollDiplomaticResponse(0, 0)).toBe('reject')
  })

  it('信任度高 + rand 大 → accept', () => {
    // trust=80 拒绝率 0.2，flake 概率 0；rand=0.9 > 0.2 → accept
    expect(rollDiplomaticResponse(80, 0.9)).toBe('accept')
  })

  it('信任度低 + 抗命统帅 → flake 概率提升', () => {
    // trust=10：拒绝率高；抗命 flake 概率提升（至少 0.1）。
    // rand 落在 rejectRate 与 rejectRate+flakeProb 之间 → flake
    // 这里验证抗命态下存在 flake 可能（rand 在拒绝率之外但小于拒绝率+flake）
    const responses = new Set<DiplomaticResponseType>()
    for (let i = 0; i < 1000; i++) {
      responses.add(rollDiplomaticResponse(10, i / 1000, true))
    }
    expect(responses.has('flake')).toBe(true)
  })

  it('信任度=30 边界：拒绝率=0.2', () => {
    // rand<0.2 → reject；rand>=0.2 → accept（无 flake，倒戈概率 0）
    expect(rollDiplomaticResponse(30, 0.1)).toBe('reject')
    expect(rollDiplomaticResponse(30, 0.5)).toBe('accept')
  })
})

describe('inferRequestKind', () => {
  it('关键词命中分类', () => {
    expect(inferRequestKind('请求盟友空中支援')).toBe('air_support')
    expect(inferRequestKind('需要炮兵火力')).toBe('artillery_support')
    expect(inferRequestKind('请求增援')).toBe('reinforcement')
    expect(inferRequestKind('弹药补给不足')).toBe('supply')
    expect(inferRequestKind('共享情报')).toBe('intelligence')
    expect(inferRequestKind('请求停火')).toBe('ceasefire')
  })

  it('无命中 → other', () => {
    expect(inferRequestKind('你好')).toBe('other')
  })
})

describe('describeRequestKind / describeResponseType / responseColor', () => {
  it('请求类别中文', () => {
    expect(describeRequestKind('air_support')).toBe('空中支援')
    expect(describeRequestKind('other')).toBe('外交请求')
  })

  it('响应类别中文', () => {
    expect(describeResponseType('accept')).toBe('答应履约')
    expect(describeResponseType('reject')).toBe('拒绝')
    expect(describeResponseType('flake')).toBe('答应却掉链子')
  })

  it('响应配色', () => {
    expect(responseColor('accept')).toBe('#4caf50')
    expect(responseColor('reject')).toBe('#9e9e9e')
    expect(responseColor('flake')).toBe('#e53935')
  })
})

describe('applyDiplomacyResultToFaction（信任度记录持久化）', () => {
  /** 构造最小阵营（含 trust 数值，无 trustRecords） */
  function makeFaction(overrides: Partial<Faction> = {}): Faction {
    return {
      id: 'ally',
      name: '盟友',
      color: '#0F0',
      side: 'ally',
      commander: {
        id: 'c1', name: '指挥官', personality: '', aggression: 0.5,
        obedience: 0.5, preferredTempo: 'balanced', doctrineTags: [],
      },
      theaterCommanders: [],
      supply: { supplies: 80, ammunition: 80, fuel: 80 },
      trust: { player: 60 },
      doctrineTags: [],
      ...overrides,
    }
  }

  it('履约：trust 数值 + trustRecords 同步更新（honoredCount+1）', () => {
    const faction = makeFaction()
    const response = makeResponse({ type: 'accept' })
    const result = resolveDiplomaticResponse(makeTrust({ trust: 60 }), response)
    const updated = applyDiplomacyResultToFaction(faction, result, 'player')
    // trust 数值更新
    expect(updated.trust['player']).toBe(result.trustAfter.trust)
    // trustRecords 富语义记录更新（honoredCount 累加）
    expect(updated.trustRecords).toBeDefined()
    expect(updated.trustRecords!['player'].honoredCount).toBe(1)
    expect(updated.trustRecords!['player'].brokenCount).toBe(0)
    expect(updated.trustRecords!['player'].trust).toBe(result.trustAfter.trust)
  })

  it('毁约：brokenCount+1', () => {
    const faction = makeFaction()
    const response = makeResponse({ type: 'flake' })
    const result = resolveDiplomaticResponse(makeTrust({ trust: 60 }), response)
    const updated = applyDiplomacyResultToFaction(faction, result, 'player')
    expect(updated.trustRecords!['player'].brokenCount).toBe(1)
    expect(updated.trustRecords!['player'].honoredCount).toBe(0)
  })

  it('不可变：不原地改输入 faction', () => {
    const faction = makeFaction()
    const response = makeResponse({ type: 'accept' })
    const result = resolveDiplomaticResponse(makeTrust({ trust: 60 }), response)
    applyDiplomacyResultToFaction(faction, result, 'player')
    // 原对象的 trustRecords 仍为 undefined（未被原地添加）
    expect(faction.trustRecords).toBeUndefined()
    expect(faction.trust['player']).toBe(60)
  })

  it('保留其他对方阵营的信任记录', () => {
    const faction = makeFaction({
      trust: { player: 60, enemy: 5 },
      trustRecords: {
        enemy: { trust: 5, stance: 'enemy', honoredCount: 0, brokenCount: 2, lastChangeTurn: 3 },
      },
    })
    const response = makeResponse({ type: 'accept' })
    const result = resolveDiplomaticResponse(makeTrust({ trust: 60 }), response)
    const updated = applyDiplomacyResultToFaction(faction, result, 'player')
    // enemy 记录保留，player 记录新增
    expect(updated.trustRecords!['enemy'].brokenCount).toBe(2)
    expect(updated.trustRecords!['player']).toBeDefined()
    expect(updated.trust['enemy']).toBe(5)
  })
})

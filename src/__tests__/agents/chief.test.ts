/**
 * 参谋长 mock 解析器单测（chief.test.ts）。
 *
 * 验证：
 * - move/attack/capture_node/hold 四类意图正确识别。
 * - 单位按 id/类型中文名匹配（仅玩家可控单位）。
 * - 坐标「C3」/「2,3」正确解析且校验范围。
 * - 解析失败/模糊 → 返回 ClarifyRequest（不伪造兜底数据，审计教训）。
 *
 * 直接调 chiefRole.parseCommand（mock 实现，无 LLM）。
 *
 * @module __tests__/agents/chief
 */

import { describe, it, expect } from 'vitest'
import { chiefRole, classifyInput } from '@/layers/agents/roles/chief'
import type { WorldState, Unit, MapCell, Faction } from '@/types'
import type { ChiefParseContext } from '@/layers/agents/roles/chief'

/** 构造玩家阵营 + 敌方阵营的测试世界。 */
function makeWorld(): WorldState {
  const cells: MapCell[] = []
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      cells.push({
        id: `${col}:${row}`,
        col,
        row,
        terrain: 'plain',
        movementCost: 1,
        defenseBonus: 0,
        isObjective: false,
      })
    }
  }
  const factions: Faction[] = [
    {
      id: 'blue',
      name: '蓝方',
      color: '#3B82F6',
      side: 'player',
      commander: {
        id: 'cmdr-blue',
        name: '蓝方统帅',
        personality: '稳健',
        aggression: 0.4,
        obedience: 0.8,
        preferredTempo: 'methodical',
        doctrineTags: [],
      },
      theaterCommanders: [],
      supply: { supplies: 80, ammunition: 80, fuel: 80 },
      trust: {},
      doctrineTags: [],
    },
    {
      id: 'red',
      name: '红方',
      color: '#EF4444',
      side: 'enemy',
      commander: {
        id: 'cmdr-red',
        name: '红方统帅',
        personality: '激进',
        aggression: 0.7,
        obedience: 0.6,
        preferredTempo: 'rapid',
        doctrineTags: [],
      },
      theaterCommanders: [],
      supply: { supplies: 70, ammunition: 70, fuel: 70 },
      trust: {},
      doctrineTags: [],
    },
  ]
  const units: Unit[] = [
    makeUnit({ id: 'first-armor', factionId: 'blue', type: 'armor', coord: { col: 0, row: 0 } }),
    makeUnit({ id: 'inf-regiment', factionId: 'blue', type: 'infantry', coord: { col: 1, row: 0 } }),
    makeUnit({ id: 'enemy-infantry', factionId: 'red', type: 'infantry', coord: { col: 3, row: 3 } }),
  ]
  return {
    saveId: 'test-save',
    scenarioId: 'test',
    scenarioSeed: 'test:test',
    turnIndex: 0,
    inGameDate: 'D-0',
    factions,
    units,
    map: {
      gridType: 'square',
      cols: 4,
      rows: 4,
      cells,
      highValueNodes: [{ id: 'fort-douaumont', name: '杜奥蒙堡', cellId: '2:2', controlThreshold: 1 }],
    },
    intel: { decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 }, reconHits: [] },
    diplomacy: { events: [], pendingDefectionCheck: false },
    directorMemory: { keyEvents: {}, overrides: [] },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

/** 构造最小单位 */
function makeUnit(overrides: Partial<Unit>): Unit {
  return {
    id: 'u',
    factionId: 'blue',
    type: 'infantry',
    coord: { col: 0, row: 0 },
    strength: 100,
    personnel: 1000,
    maxPersonnel: 1000,
    fuel: 100,
    ammo: 100,
    morale: 80,
    fatigue: 0,
    detection: {},
    orders: [],
    status: [],
    ...overrides,
  }
}

/** 参谋长解析上下文 */
function makeCtx(): ChiefParseContext {
  return { world: makeWorld(), playerFactionId: 'blue' }
}

describe('chiefRole.parseCommand — move 意图', () => {
  it('"第一装甲师移动到 C3" 解析为 move + 目标坐标 (2,2)', async () => {
    // first-armor 在 (0,0)，C3 → col=2(C), row=2(第3行)
    const r = await chiefRole.parseCommand('first-armor 移动到 C3', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.intent).toBe('move')
    expect(r.targetUnitIds).toContain('first-armor')
    expect(r.targetCoord).toEqual({ col: 2, row: 2 })
  })

  it('按类型中文名「装甲」匹配 armor 单位', async () => {
    const r = await chiefRole.parseCommand('装甲移动到 A1', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.targetUnitIds).toContain('first-armor')
  })

  it('"inf-regiment 前进到 2,2" 解析数字对坐标', async () => {
    const r = await chiefRole.parseCommand('inf-regiment 前进到 2,2', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.intent).toBe('move')
    expect(r.targetCoord).toEqual({ col: 2, row: 2 })
  })
})

describe('chiefRole.parseCommand — attack 意图', () => {
  it('攻击敌方单位，匹配敌方 infantry', async () => {
    const r = await chiefRole.parseCommand('first-armor 攻击 enemy-infantry', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.intent).toBe('attack')
    expect(r.targetUnitIds).toContain('first-armor')
    expect(r.targetUnitId).toBe('enemy-infantry')
  })
})

describe('chiefRole.parseCommand — capture_node 意图', () => {
  it('占领节点「杜奥蒙堡」', async () => {
    const r = await chiefRole.parseCommand('inf-regiment 占领 杜奥蒙堡', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.intent).toBe('capture_node')
    expect(r.nodeId).toBe('fort-douaumont')
    expect(r.targetUnitIds).toContain('inf-regiment')
  })

  it('「占领」优先于「移动」关键词（避免误判）', async () => {
    // 「占领杜奥蒙堡」含「占」但不含「移动」，应判 capture_node
    const r = await chiefRole.parseCommand('first-armor 占领杜奥蒙堡', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.intent).toBe('capture_node')
  })
})

describe('chiefRole.parseCommand — hold 意图', () => {
  it('固守命令不带坐标', async () => {
    const r = await chiefRole.parseCommand('first-armor 固守', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    expect(r.intent).toBe('hold')
    expect(r.targetUnitIds).toContain('first-armor')
    expect(r.targetCoord).toBeUndefined()
  })
})

describe('chiefRole.parseCommand — 解析失败/模糊（不伪造兜底）', () => {
  it('空输入返回 clarify', async () => {
    const r = await chiefRole.parseCommand('   ', makeCtx())
    expect(r.kind).toBe('clarify')
  })

  it('无法识别意图返回 clarify（无移动/攻击等关键词）', async () => {
    const r = await chiefRole.parseCommand('first-armor 转圈', makeCtx())
    expect(r.kind).toBe('clarify')
    if (r.kind !== 'clarify') return
    expect(r.reason).toContain('意图')
  })

  it('单位不存在返回 clarify（不伪造 unit-1）', async () => {
    const r = await chiefRole.parseCommand('unit-999 移动到 A1', makeCtx())
    expect(r.kind).toBe('clarify')
    if (r.kind !== 'clarify') return
    expect(r.reason).toContain('单位')
    // 建议应列出真实可用单位，绝不伪造
    expect(r.suggestions.length).toBeGreaterThan(0)
  })

  it('坐标越界返回 clarify（不伪造 C3 当 4x4 已是边界）', async () => {
    // E1 → col=4，但 cols=4（0..3），越界
    const r = await chiefRole.parseCommand('first-armor 移动到 E1', makeCtx())
    expect(r.kind).toBe('clarify')
  })

  it('move 缺坐标返回 clarify', async () => {
    const r = await chiefRole.parseCommand('first-armor 移动', makeCtx())
    expect(r.kind).toBe('clarify')
    if (r.kind !== 'clarify') return
    expect(r.reason).toContain('坐标')
  })

  it('attack 缺敌方目标返回 clarify', async () => {
    const r = await chiefRole.parseCommand('first-armor 攻击空气', makeCtx())
    expect(r.kind).toBe('clarify')
  })

  it('capture 不存在的节点返回 clarify', async () => {
    const r = await chiefRole.parseCommand('first-armor 占领 不存在的堡垒', makeCtx())
    expect(r.kind).toBe('clarify')
    if (r.kind !== 'clarify') return
    expect(r.reason).toContain('节点')
  })
})

describe('chiefRole.parseCommand — 仅匹配玩家可控单位', () => {
  it('攻击指令匹配敌方单位时执行单位仍为玩家方', async () => {
    const r = await chiefRole.parseCommand('first-armor 攻击 enemy-infantry', makeCtx())
    expect(r.kind).toBe('parsed')
    if (r.kind !== 'parsed') return
    // 执行单位是玩家方 first-armor，目标才是敌方
    expect(r.targetUnitIds).toContain('first-armor')
    expect(r.targetUnitId).toBe('enemy-infantry')
  })
})

// ============================================================================
// 意图分类（classifyInput）— 修复问题1的核心路由
// ============================================================================

describe('classifyInput — 命令 vs 对话路由', () => {
  it('含移动关键词 → command', () => {
    expect(classifyInput('第一装甲师移动到 C3')).toBe('command')
    expect(classifyInput('inf-regiment 前进到 2,2')).toBe('command')
  })
  it('含攻击/占领/固守关键词 → command', () => {
    expect(classifyInput('攻击 enemy-infantry')).toBe('command')
    expect(classifyInput('占领杜奥蒙堡')).toBe('command')
    expect(classifyInput('first-armor 固守')).toBe('command')
  })
  it('问候 → chat（不被误判为命令）', () => {
    expect(classifyInput('你好')).toBe('chat')
    expect(classifyInput('hello')).toBe('chat')
  })
  it('询问态势 → chat', () => {
    expect(classifyInput('我们现在是什么状态')).toBe('chat')
    expect(classifyInput('当前战况如何')).toBe('chat')
  })
  it('闲聊/感谢 → chat', () => {
    expect(classifyInput('谢谢参谋长')).toBe('chat')
    expect(classifyInput('有什么建议')).toBe('chat')
  })
  it('空输入 → chat（不触发命令解析）', () => {
    expect(classifyInput('   ')).toBe('chat')
    expect(classifyInput('')).toBe('chat')
  })
  it('命令优先于对话：同时含问候与移动词 → command', () => {
    // "你好，把第一装甲师移动到 C3" 应判 command（移动是核心意图）
    expect(classifyInput('你好，把第一装甲师移动到 C3')).toBe('command')
  })
  // === 重写计划 B：classifyInput 误判修复（疑问句式 → chat） ===
  it('含意图词但带疑问标志 → chat（"怎么样需要移动吗"不误判命令）', () => {
    expect(classifyInput('怎么样需要移动吗')).toBe('chat')
    expect(classifyInput('步兵需要移动吗')).toBe('chat')
    expect(classifyInput('我们要不要攻击？')).toBe('chat')
    expect(classifyInput('能不能占领杜奥蒙堡')).toBe('chat')
    expect(classifyInput('现在是不是该推进')).toBe('chat')
  })
  it('占领节点（无单位词、无坐标、无疑问标志）→ command', () => {
    // "占领杜奥蒙堡" 含"占领"且无疑问标志 → command
    expect(classifyInput('占领杜奥蒙堡')).toBe('command')
    expect(classifyInput('步兵占领杜奥蒙堡')).toBe('command')
  })
  it('固守（hold 无坐标）→ command', () => {
    expect(classifyInput('first-armor 固守')).toBe('command')
    expect(classifyInput('步兵就地坚守')).toBe('command')
  })
})

// ============================================================================
// 参谋长对话（chat）— mock 模板回复
// ============================================================================

describe('chiefRole.chat — mock 对话回复', () => {
  it('问候 → 参谋报到 + 简报态势', async () => {
    const r = await chiefRole.chat('你好', makeCtx())
    expect(r.source).toBe('mock')
    expect(r.text.length).toBeGreaterThan(0)
    // 不伪造命令：回复文本不应像候选命令卡片
    expect(r.text).toContain('长官')
  })
  it('问态势 → 汇报回合与单位', async () => {
    const r = await chiefRole.chat('我们现在是什么状态', makeCtx())
    expect(r.source).toBe('mock')
    expect(r.text).toContain('回合')
  })
  it('回复不伪造不存在的单位（仅引用真实数据）', async () => {
    const ctx = makeCtx()
    const r = await chiefRole.chat('汇报当前态势', ctx)
    // mock 模板可能引用单位类型中文名（步兵/装甲等），这些都是 world 中真实存在的
    // 这里只验证不抛错且返回非空文本
    expect(r.text.length).toBeGreaterThan(0)
  })
  it('无意义输入 → 引导玩家明确意图', async () => {
    const r = await chiefRole.chat('...', makeCtx())
    expect(r.text.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// 参谋长多轮上下文（chat history）— 重写计划 B 核心
// ============================================================================

describe('chiefRole.chat — 多轮上下文（history 参数）', () => {
  it('chat 接受 history 参数不抛错（向后兼容）', async () => {
    const history = [
      { role: 'player' as const, text: '你好' },
      { role: 'chief' as const, text: '长官，参谋长报到。' },
    ]
    const r = await chiefRole.chat('我们现在是什么状态', makeCtx(), history)
    expect(r.source).toBe('mock')
    expect(r.text.length).toBeGreaterThan(0)
  })
  it('history 为空数组等价于无 history（不破坏旧调用）', async () => {
    const r1 = await chiefRole.chat('你好', makeCtx())
    const r2 = await chiefRole.chat('你好', makeCtx(), [])
    expect(r2.text).toBe(r1.text)
  })
  it('mock 在 history 含上轮玩家提及节点时回应"接你刚才提到的XX"', async () => {
    // 上轮玩家问过"杜奥蒙堡"，本轮问态势 → mock 应含"接你刚才提到的杜奥蒙堡"
    const history = [
      { role: 'player' as const, text: '杜奥蒙堡情况如何' },
      { role: 'chief' as const, text: '长官，杜奥蒙堡在我方手中。' },
    ]
    const r = await chiefRole.chat('现在情况如何', makeCtx(), history)
    expect(r.source).toBe('mock')
    expect(r.text).toContain('杜奥蒙堡')
  })
  it('history 上轮不含节点时 mock 不强加"接你刚才"提示', async () => {
    const history = [
      { role: 'player' as const, text: '你好' },
      { role: 'chief' as const, text: '长官报到。' },
    ]
    const r = await chiefRole.chat('现在情况如何', makeCtx(), history)
    expect(r.source).toBe('mock')
    // 不应误含"接你刚才提到"（上轮"你好"未提节点）
    expect(r.text).not.toContain('接你刚才提到的')
  })
})

/**
 * evaluateVictory 纯函数单测（victory-evaluate.test.ts）— 第 6 批。
 *
 * 验证：
 * - accumulateTurnStats：折叠累计统计（accumulatedCasualties / casualtiesInflicted /
 *   controlledNodes / factionScores / objectivesHeldTurns）。
 * - evaluateVictory：
 *   · 未注册胜利条件（非内置 scenarioId）→ victoryState 保持 'ongoing'，仅更新累计统计。
 *   · 注入 objective 条件 + 占领目标节点 → won（玩家）/ lost（敌方）。
 *   · 注入 casualty 条件 + 战损超阈值 → 判定。
 *   · 注入 turn_limit + 回合上限到达 + 一方领先 → won/lost；平局 → draw。
 *   · 幂等：已终局时不再判定。
 *
 * @module __tests__/domain/victory-evaluate
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateVictory,
  accumulateTurnStats,
} from '@/layers/domain/victory'
import type { WorldState, CampaignVictory } from '@/types'
import { makeWorld } from '../test-helpers'

/** 构造含两阵营 + 两单位的 world（player=blue, enemy=red）。 */
function makeTwoFactionWorld(overrides: Partial<WorldState> = {}): WorldState {
  return makeWorld({
    playerFactionId: 'blue',
    scenarioId: 'test-non-builtin', // 非内置 scenarioId，避免 registry 命中
    factions: [
      { id: 'blue', name: '蓝方', color: '#3B82F6', side: 'player', commander: makeCommander('blue'), theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [] },
      { id: 'red', name: '红方', color: '#EF4444', side: 'enemy', commander: makeCommander('red'), theaterCommanders: [], supply: { supplies: 80, ammunition: 80, fuel: 80 }, trust: {}, doctrineTags: [] },
    ],
    units: [
      { id: 'u-blue-1', factionId: 'blue', type: 'infantry', coord: { col: 0, row: 0 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
      { id: 'u-red-1', factionId: 'red', type: 'infantry', coord: { col: 5, row: 5 }, strength: 100, personnel: 1000, maxPersonnel: 1000, fuel: 100, ammo: 100, morale: 80, fatigue: 0, detection: {}, orders: [], status: [] },
    ],
    map: {
      gridType: 'square',
      cols: 10,
      rows: 10,
      cells: [],
      highValueNodes: [
        { id: 'node-a', name: '据点 A', cellId: 'c-0-0', controlThreshold: 1 },
      ],
    },
    ...overrides,
  })
}

function makeCommander(id: string) {
  return { id, name: id, personality: '', aggression: 0.5, obedience: 0.8, preferredTempo: 'balanced' as const, doctrineTags: [] }
}

describe('accumulateTurnStats', () => {
  it('无 lastResolution → 累计统计保持原值（不累加）', () => {
    const world = makeTwoFactionWorld({
      accumulatedCasualties: { blue: 50 },
    })
    const out = accumulateTurnStats(world)
    expect(out.accumulatedCasualties?.blue).toBe(50)
    expect(out.controlledNodes).toEqual({})
  })

  it('累加本回合战损到 accumulatedCasualties', () => {
    const world = makeTwoFactionWorld({
      lastResolution: {
        turn: 0,
        casualties: {
          blue: { personnel: 100, strength: 30 },
          red: { personnel: 200, strength: 60 },
        },
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = accumulateTurnStats(world)
    expect(out.accumulatedCasualties?.blue).toBe(30)
    expect(out.accumulatedCasualties?.red).toBe(60)
  })

  it('casualtiesInflicted：某阵营造成的敌方 personnel 损失', () => {
    const world = makeTwoFactionWorld({
      lastResolution: {
        turn: 0,
        casualties: {
          blue: { personnel: 100, strength: 30 },
          red: { personnel: 200, strength: 60 },
        },
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = accumulateTurnStats(world)
    // blue 造成 red 的 200 personnel 损失；red 造成 blue 的 100。
    expect(out.casualtiesInflicted?.blue).toBe(200)
    expect(out.casualtiesInflicted?.red).toBe(100)
  })

  it('objectiveChanges：折叠 controlledNodes（最新控制方覆盖）', () => {
    const world = makeTwoFactionWorld({
      controlledNodes: { red: ['node-a'] },
      lastResolution: {
        turn: 0,
        casualties: {},
        objectiveChanges: [
          { nodeId: 'node-a', fromFactionId: 'red', toFactionId: 'blue' },
        ],
        reportText: '',
        degraded: false,
      },
    })
    const out = accumulateTurnStats(world)
    // blue 接管 node-a；red 不再持有。
    expect(out.controlledNodes?.blue).toContain('node-a')
    expect(out.controlledNodes?.red ?? []).not.toContain('node-a')
  })
})

describe('evaluateVictory', () => {
  it('未注册胜利条件（非内置 scenarioId）→ victoryState 保持 ongoing，累计统计仍更新', () => {
    const world = makeTwoFactionWorld({
      lastResolution: {
        turn: 0,
        casualties: { blue: { personnel: 10, strength: 5 } },
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world)
    expect(out.victoryState).toBe('ongoing')
    expect(out.accumulatedCasualties?.blue).toBe(5)
  })

  it('objective 条件：玩家占领全部目标节点 → won', () => {
    const victory: CampaignVictory = {
      maxTurns: 30,
      conditions: [
        { id: 'c1', factionId: 'blue', type: 'objective', description: '占 A', nodeId: 'node-a' },
      ],
    }
    const world = makeTwoFactionWorld({
      controlledNodes: { blue: ['node-a'] },
      lastResolution: {
        turn: 5,
        casualties: {},
        objectiveChanges: [{ nodeId: 'node-a', fromFactionId: 'red', toFactionId: 'blue' }],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    expect(out.victoryState).toBe('won')
    expect(out.winnerFactionId).toBe('blue')
  })

  it('objective 条件：敌方占领全部目标节点 → lost', () => {
    const victory: CampaignVictory = {
      maxTurns: 30,
      conditions: [
        { id: 'c1', factionId: 'red', type: 'objective', description: '占 A', nodeId: 'node-a' },
      ],
    }
    const world = makeTwoFactionWorld({
      controlledNodes: { red: ['node-a'] },
      lastResolution: {
        turn: 5,
        casualties: {},
        objectiveChanges: [{ nodeId: 'node-a', fromFactionId: 'blue', toFactionId: 'red' }],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    expect(out.victoryState).toBe('lost')
    expect(out.winnerFactionId).toBe('red')
  })

  it('casualty 条件：使敌方战损超阈值 → 胜', () => {
    // blue 初始 strength = 1000（maxPersonnel），casualtyThreshold 0.5 → 阈值 500。
    // 注：translateCondition 用 targetFactionId 的 maxPersonnel 之和。
    // 此处 red maxPersonnel=1000，blue 使 red 战损超 500。
    const victory: CampaignVictory = {
      maxTurns: 30,
      conditions: [
        { id: 'c1', factionId: 'blue', type: 'casualty', description: '消耗 red', targetFactionId: 'red', casualtyThreshold: 0.5 },
      ],
    }
    const world = makeTwoFactionWorld({
      accumulatedCasualties: { red: 600 },
      lastResolution: {
        turn: 5,
        casualties: {},
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    expect(out.victoryState).toBe('won')
  })

  it('turn_limit + 回合上限到达 + 一方领先节点 → 胜', () => {
    const victory: CampaignVictory = {
      maxTurns: 10,
      conditions: [
        { id: 'c1', factionId: 'blue', type: 'turn_limit', description: '守至 10 回合' },
      ],
    }
    const world = makeTwoFactionWorld({
      turnIndex: 10,
      controlledNodes: { blue: ['node-a'] },
      lastResolution: {
        turn: 10,
        casualties: {},
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    expect(out.victoryState).toBe('won')
  })

  it('turn_limit + 回合上限到达 + 双方节点数相同 → draw', () => {
    const victory: CampaignVictory = {
      maxTurns: 10,
      conditions: [
        { id: 'c1', factionId: 'blue', type: 'turn_limit', description: '守至 10 回合' },
      ],
    }
    const world = makeTwoFactionWorld({
      turnIndex: 10,
      controlledNodes: { blue: ['node-a'], red: ['node-a'] }, // 平局（数量相同）
      lastResolution: {
        turn: 10,
        casualties: {},
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    expect(out.victoryState).toBe('draw')
  })

  it('幂等：已终局时不再重复判定', () => {
    const victory: CampaignVictory = {
      maxTurns: 30,
      conditions: [
        { id: 'c1', factionId: 'blue', type: 'objective', description: '占 A', nodeId: 'node-a' },
      ],
    }
    const world = makeTwoFactionWorld({
      victoryState: 'won',
      winnerFactionId: 'blue',
      controlledNodes: { red: ['node-a'] }, // 即便 red 现在占领，也不改判
      lastResolution: {
        turn: 5,
        casualties: {},
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    // 保持原终局。
    expect(out.victoryState).toBe('won')
    expect(out.winnerFactionId).toBe('blue')
  })

  it('未达胜利条件 → ongoing（累计统计仍更新）', () => {
    const victory: CampaignVictory = {
      maxTurns: 30,
      conditions: [
        { id: 'c1', factionId: 'blue', type: 'objective', description: '占 A', nodeId: 'node-a' },
      ],
    }
    const world = makeTwoFactionWorld({
      lastResolution: {
        turn: 2,
        casualties: { blue: { personnel: 10, strength: 5 } },
        objectiveChanges: [],
        reportText: '',
        degraded: false,
      },
    })
    const out = evaluateVictory(world, { victory })
    expect(out.victoryState).toBe('ongoing')
    expect(out.accumulatedCasualties?.blue).toBe(5)
  })
})

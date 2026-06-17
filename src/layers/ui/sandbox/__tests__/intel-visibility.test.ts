/**
 * 情报可见性渲染决策（intel-visibility）单测。
 *
 * 验证：各级别渲染模式、残影判定、可见字段截断、己方恒 L3、recon 刷新判定。
 *
 * @module layers/ui/sandbox/__tests__/intel-visibility
 */

import { describe, expect, it } from 'vitest'
import {
  computeIntelRender,
  decideRenderMode,
  ghostAlpha,
  ghostLabel,
  visibleFieldsFor,
  listObservedEnemyUnits,
  toIntelSnapshot,
  getPlayerFactionId,
  shouldRefreshOnRecon,
} from '@/layers/ui/sandbox/intel-visibility'
import type { Faction, Unit, IntelObservation } from '@/types'

/** 构造观测记录 */
function makeObs(overrides: Partial<IntelObservation> = {}): IntelObservation {
  return {
    observerFactionId: 'red',
    level: 3,
    lastSeenTurn: 0,
    staleTurns: 0,
    ...overrides,
  }
}

/** 构造单位 */
function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    factionId: 'red',
    type: 'infantry',
    coord: { col: 0, row: 0 },
    strength: 80,
    personnel: 1000,
    maxPersonnel: 1000,
    fuel: 90,
    ammo: 70,
    morale: 80,
    fatigue: 0,
    detection: {},
    orders: [],
    status: [],
    ...overrides,
  }
}

/** 构造阵营 */
function makeFaction(side: 'player' | 'enemy' | 'ally' = 'enemy'): Faction {
  return {
    id: side === 'player' ? 'blue' : side === 'ally' ? 'green' : 'red',
    name: side,
    color: '#3B82F6',
    side,
    commander: {
      id: 'c1',
      name: '指挥官',
      personality: '',
      aggression: 0.5,
      obedience: 0.5,
      preferredTempo: 'balanced',
      doctrineTags: [],
    },
    theaterCommanders: [],
    supply: { supplies: 100, ammunition: 100, fuel: 100 },
    trust: {},
    doctrineTags: [],
  }
}

describe('decideRenderMode', () => {
  it('己方单位 → own', () => {
    const u = makeUnit({ factionId: 'blue' })
    expect(decideRenderMode(u, 'blue')).toBe('own')
  })

  it('L0 → hidden', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ observerFactionId: 'blue', level: 0 }) },
    })
    expect(decideRenderMode(u, 'blue')).toBe('hidden')
  })

  it('L1 → heat-pulse', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ observerFactionId: 'blue', level: 1 }) },
    })
    expect(decideRenderMode(u, 'blue')).toBe('heat-pulse')
  })

  it('L2 → formation', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ observerFactionId: 'blue', level: 2 }) },
    })
    expect(decideRenderMode(u, 'blue')).toBe('formation')
  })

  it('L3 → full', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ observerFactionId: 'blue', level: 3 }) },
    })
    expect(decideRenderMode(u, 'blue')).toBe('full')
  })

  it('无观测记录 → 默认 fallbackLevel（敌方默认 hidden/L0）', () => {
    const u = makeUnit({ factionId: 'red', detection: {} })
    expect(decideRenderMode(u, 'blue')).toBe('hidden')
  })
})

describe('computeIntelRender', () => {
  it('己方：恒 own / L3 / 无残影 / lastSeen=当前回合', () => {
    const u = makeUnit({ factionId: 'blue' })
    const r = computeIntelRender(u, 'blue', 5)
    expect(r.mode).toBe('own')
    expect(r.level).toBe(3)
    expect(r.ghost).toBe(false)
    expect(r.staleTurns).toBe(0)
    expect(r.lastSeenTurn).toBe(5)
  })

  it('L0 盲区：刚命中时无残影，不显示', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 0, lastSeenTurn: 5 }) },
    })
    const r = computeIntelRender(u, 'blue', 5)
    expect(r.mode).toBe('hidden')
    expect(r.ghost).toBe(false) // 刚命中 stale=0
  })

  it('L0 盲区但已过期：标记残影（曾观测现已失联）', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 0, lastSeenTurn: 0 }) },
    })
    const r = computeIntelRender(u, 'blue', 5)
    expect(r.mode).toBe('hidden')
    expect(r.ghost).toBe(true) // stale=5 >=3
  })

  it('无观测记录：hidden + staleTurns=当前回合', () => {
    const u = makeUnit({ factionId: 'red', detection: {} })
    const r = computeIntelRender(u, 'blue', 7)
    expect(r.mode).toBe('hidden')
    expect(r.staleTurns).toBe(7)
    expect(r.lastSeenTurn).toBe(0)
  })

  it('残影：超半衰（stale>=3）→ ghost=true', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 2, lastSeenTurn: 0 }) },
    })
    const r = computeIntelRender(u, 'blue', 5, 3) // stale=5 >=3
    expect(r.ghost).toBe(true)
    expect(r.ghostTurns).toBe(1) // floor(5/3)=1
    expect(r.staleTurns).toBe(5)
  })

  it('未超半衰：无残影', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 3, lastSeenTurn: 3 }) },
    })
    const r = computeIntelRender(u, 'blue', 5, 3) // stale=2 <3
    expect(r.ghost).toBe(false)
    expect(r.ghostTurns).toBe(0)
  })

  it('刚命中（stale=0）：无残影', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 3, lastSeenTurn: 5 }) },
    })
    const r = computeIntelRender(u, 'blue', 5, 3)
    expect(r.ghost).toBe(false)
  })
})

describe('ghostLabel / ghostAlpha', () => {
  it('无残影 → 空标签 / alpha=1', () => {
    const r = { ghost: false, ghostTurns: 0 } as never
    expect(ghostLabel(r)).toBe('')
    expect(ghostAlpha(r)).toBe(1)
  })

  it('残影 1 倍 → [T-1h] / alpha=0.45', () => {
    const r = { ghost: true, ghostTurns: 1 } as never
    expect(ghostLabel(r)).toBe('[T-1h]')
    expect(ghostAlpha(r)).toBeCloseTo(0.45)
  })

  it('残影越久越淡，下限 0.15', () => {
    const r = { ghost: true, ghostTurns: 10 } as never
    expect(ghostAlpha(r)).toBeGreaterThanOrEqual(0.15)
    expect(ghostAlpha(r)).toBe(0.15)
  })
})

describe('visibleFieldsFor', () => {
  it('hidden → 空', () => {
    expect(visibleFieldsFor({ mode: 'hidden' } as never)).toEqual([])
  })

  it('heat-pulse → 仅 coord/faction', () => {
    expect(visibleFieldsFor({ mode: 'heat-pulse' } as never)).toEqual(['coord', 'faction'])
  })

  it('formation → + type，无精确数值', () => {
    const fields = visibleFieldsFor({ mode: 'formation' } as never)
    expect(fields).toContain('type')
    expect(fields).not.toContain('strength')
  })

  it('full/own → 含精确数值', () => {
    for (const mode of ['full', 'own'] as const) {
      const fields = visibleFieldsFor({ mode } as never)
      expect(fields).toContain('strength')
      expect(fields).toContain('fuel')
      expect(fields).toContain('ammo')
    }
  })
})

describe('listObservedEnemyUnits', () => {
  it('排除己方单位 + L0 盲区', () => {
    const units = [
      makeUnit({ id: 'own', factionId: 'blue' }),
      makeUnit({
        id: 'blind',
        factionId: 'red',
        detection: { blue: makeObs({ level: 0 }) },
      }),
      makeUnit({
        id: 'seen',
        factionId: 'red',
        detection: { blue: makeObs({ level: 2 }) },
      }),
    ]
    const observed = listObservedEnemyUnits(units, 'blue', 0)
    expect(observed.map((u) => u.id)).toEqual(['seen'])
  })
})

describe('toIntelSnapshot', () => {
  it('浓缩为情报快照', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 3, lastSeenTurn: 0 }) },
    })
    const snap = toIntelSnapshot(u, 'blue', 5)
    expect(snap.level).toBe(3)
    expect(snap.visibleFields).toContain('strength')
  })
})

describe('getPlayerFactionId', () => {
  it('取首个 side=player 阵营', () => {
    expect(getPlayerFactionId([makeFaction('enemy'), makeFaction('player')])).toBe('blue')
  })

  it('无玩家阵营 → 空串', () => {
    expect(getPlayerFactionId([makeFaction('enemy')])).toBe('')
  })

  // 视角 bug 修复：显式 playerFactionId 优先（v0.2.2+ 存档从 world.playerFactionId 注入）
  it('传入 playerFactionId → 优先返回（即便 factions 里 side=player 是别的阵营）', () => {
    // factions 里 side=player 的是 blue，但显式注入 red 为玩家 → 返回 red
    expect(getPlayerFactionId([makeFaction('player'), makeFaction('enemy')], 'red')).toBe('red')
  })

  it('playerFactionId 为空串 → fallback side=player', () => {
    expect(getPlayerFactionId([makeFaction('player')], '')).toBe('blue')
  })
})

describe('shouldRefreshOnRecon', () => {
  it('己方单位 → 不刷新', () => {
    const u = makeUnit({ factionId: 'blue' })
    expect(shouldRefreshOnRecon(u, 'blue', 3)).toBe(false)
  })

  it('未观测 + 更高级别 → 需刷新', () => {
    const u = makeUnit({ factionId: 'red', detection: {} })
    expect(shouldRefreshOnRecon(u, 'blue', 2)).toBe(true)
  })

  it('已有更高级别 → 不刷新', () => {
    const u = makeUnit({
      factionId: 'red',
      detection: { blue: makeObs({ level: 3 }) },
    })
    expect(shouldRefreshOnRecon(u, 'blue', 2)).toBe(false)
  })
})

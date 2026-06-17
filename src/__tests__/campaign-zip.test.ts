/**
 * 战役包 ZIP 闭环 + JSON Schema 校验测试（campaign-zip.test.ts）— 验收#5。
 *
 * 覆盖：
 * - buildCampaignZip → loadCampaignZip 闭环（打包再解包字段一致）。
 * - validateCampaignPayload：合法 payload 通过 / 非法 payload throw CampaignSchemaError。
 * - loadCampaignZip：损坏 ZIP / 缺文件 / 非法 JSON / schema 校验失败各 throw。
 * - 凡尔登默认包能通过 schema 校验 + buildInitialWorldState + startCampaignFromPayload 开局。
 *
 * 纯函数（buildCampaignZip/loadCampaignZip/validateCampaignPayload/buildInitialWorldState）
 * 不依赖 Tauri；startCampaignFromPayload 经 vi.mock 替换 gateway，捕获 fs_init_save/
 * fs_write_world_state 调用而不真落盘。
 *
 * @module __tests__/campaign-zip
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { unzipSync, zipSync, strToU8 } from 'fflate'

// =============================================================================
// mock @/layers/gateway/tauri-bridge：捕获 fs 命令调用，不真落盘
// =============================================================================
const mockFs = {
  initSaveCalls: [] as Array<{ saveId: string; manifest: string }>,
  writeWorldStateCalls: [] as Array<{ saveId: string; content: string }>,
}

vi.mock('@/layers/gateway/tauri-bridge', () => ({
  fsInitSave: vi.fn(async (saveId: string, manifest: string): Promise<void> => {
    mockFs.initSaveCalls.push({ saveId, manifest })
  }),
  fsWriteWorldState: vi.fn(async (saveId: string, content: string): Promise<void> => {
    mockFs.writeWorldStateCalls.push({ saveId, content })
  }),
  fsWriteManifest: vi.fn(async (): Promise<void> => {}),
  fsListSaves: vi.fn(async (): Promise<string[]> => []),
  fsDeleteSave: vi.fn(async (): Promise<void> => {}),
  fsReadWorldState: vi.fn(async (): Promise<string> => '{}'),
  fsExportSave: vi.fn(async (): Promise<void> => {}),
  fsImportSave: vi.fn(async (): Promise<void> => {}),
  fsUnpackCampaign: vi.fn(async (): Promise<void> => {}),
}))

// =============================================================================
// 被测模块（必须在 vi.mock 之后 import）
// =============================================================================
import {
  buildCampaignZip,
  loadCampaignZip,
  validateCampaignPayload,
  CampaignSchemaError,
  CampaignZipError,
} from '@/layers/persistence'
import {
  buildInitialWorldState,
  startCampaignFromPayload,
  startDefaultCampaign,
  validateCampaignConsistency,
  CampaignConsistencyError,
} from '@/layers/persistence'
import type { CampaignPayload } from '@/types'
import { CAMPAIGN_ZIP_FILES } from '@/types'
import { verdunCampaign } from '@/data/verdun-1916'
import { guanduCampaign } from '@/data/guandu-200'
import { ukraineCampaign } from '@/data/ukraine-2022'
import { midwayCampaign } from '@/data/midway-1942'
import { iranCampaign } from '@/data/iran-2026'

// =============================================================================
// 测试 fixture：最小合法 CampaignPayload（schema 边界测试用）
// =============================================================================

/** 构造最小合法 payload（深拷贝凡尔登后裁剪，保证 schema 合法） */
function makeValidPayload(): CampaignPayload {
  return JSON.parse(JSON.stringify(verdunCampaign)) as CampaignPayload
}

beforeEach(() => {
  mockFs.initSaveCalls.length = 0
  mockFs.writeWorldStateCalls.length = 0
})

// =============================================================================
// 1. buildCampaignZip → loadCampaignZip 闭环
// =============================================================================

describe('buildCampaignZip → loadCampaignZip 闭环', () => {
  it('凡尔登包打包再解包，七文件字段一致', () => {
    const original = makeValidPayload()
    const zipBytes = buildCampaignZip(original)
    expect(zipBytes).toBeInstanceOf(Uint8Array)
    expect(zipBytes.byteLength).toBeGreaterThan(0)

    const roundtrip = loadCampaignZip(zipBytes)

    // 七文件顶层字段逐一比对
    expect(roundtrip.manifest).toEqual(original.manifest)
    expect(roundtrip.map).toEqual(original.map)
    expect(roundtrip.factions).toEqual(original.factions)
    expect(roundtrip.units).toEqual(original.units)
    expect(roundtrip.commanders).toEqual(original.commanders)
    expect(roundtrip.rules).toEqual(original.rules)
    expect(roundtrip.victory).toEqual(original.victory)
  })

  it('ZIP 内含七文件（文件名固定）', () => {
    const zipBytes = buildCampaignZip(makeValidPayload())
    // 解包后 ZIP 应包含全部七文件名（loadCampaignZip 读取的就是这些 key）
    // 通过反向构造验证：删任一文件后 loadCampaignZip 应报缺失
    const unzipped = unzipSync(zipBytes)
    const expected = Object.values(CAMPAIGN_ZIP_FILES)
    for (const name of expected) {
      expect(unzipped[name]).toBeDefined()
    }
  })
})

// =============================================================================
// 2. validateCampaignPayload：合法通过 / 非法 throw
// =============================================================================

describe('validateCampaignPayload', () => {
  it('合法凡尔登 payload 通过校验（不 throw）', () => {
    expect(() => validateCampaignPayload(makeValidPayload())).not.toThrow()
  })

  it('manifest.scenarioId 缺失 → throw CampaignSchemaError（manifest.json）', () => {
    const p = makeValidPayload()
    delete (p.manifest as Partial<typeof p.manifest>).scenarioId
    try {
      validateCampaignPayload(p)
      throw new Error('应 throw 但未 throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CampaignSchemaError)
      expect((e as CampaignSchemaError).file).toBe(CAMPAIGN_ZIP_FILES.manifest)
    }
  })

  it('map.gridType 非法值 → throw CampaignSchemaError（map.json）', () => {
    const p = makeValidPayload()
    ;(p.map as { gridType: string }).gridType = 'triangle'
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('commanders.aggression 超范围（>1）→ throw', () => {
    const p = makeValidPayload()
    p.commanders[0].aggression = 1.5
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('commanders.aggression 为负 → throw', () => {
    const p = makeValidPayload()
    p.commanders[0].aggression = -0.2
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('units 单元缺 required 字段 coord → throw', () => {
    const p = makeValidPayload()
    delete (p.units[0] as Partial<typeof p.units[0]>).coord
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('victory.conditions 空 → throw（minItems:1）', () => {
    const p = makeValidPayload()
    p.victory.conditions = []
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('rules.intelDecay 缺失 → throw（required）', () => {
    const p = makeValidPayload()
    delete (p.rules as Partial<typeof p.rules>).intelDecay
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('factions.color 非法格式 → throw', () => {
    const p = makeValidPayload()
    p.factions[0].color = 'blue'
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })

  it('manifest 含 additionalProperties 外字段 → throw（strict）', () => {
    const p = makeValidPayload()
    ;(p.manifest as unknown as Record<string, unknown>).evilField = 'inject'
    expect(() => validateCampaignPayload(p)).toThrow(CampaignSchemaError)
  })
})

// =============================================================================
// 3. loadCampaignZip：损坏 ZIP / 缺文件 / 非法 JSON
// =============================================================================

describe('loadCampaignZip 错误路径', () => {
  it('非 ZIP 字节 → throw CampaignZipError', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5])
    expect(() => loadCampaignZip(garbage)).toThrow(CampaignZipError)
  })

  it('缺文件 → throw CampaignZipError（含 missingFiles）', () => {
    const p = makeValidPayload()
    const zipBytes = buildCampaignZip(p)
    // 解包后删掉 commanders.json 再重新打包
    const unzipped = unzipSync(zipBytes)
    delete unzipped[CAMPAIGN_ZIP_FILES.commanders]
    const tampered = zipSync(unzipped)

    try {
      loadCampaignZip(tampered)
      throw new Error('应 throw 但未 throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CampaignZipError)
      expect((e as CampaignZipError).missingFiles).toContain(CAMPAIGN_ZIP_FILES.commanders)
    }
  })

  it('文件内容非法 JSON → throw CampaignSchemaError', () => {
    const p = makeValidPayload()
    const zipBytes = buildCampaignZip(p)
    const unzipped = unzipSync(zipBytes)
    // 把 manifest.json 替换为非法 JSON
    unzipped[CAMPAIGN_ZIP_FILES.manifest] = strToU8('{ not valid json ///')
    const tampered = zipSync(unzipped)

    expect(() => loadCampaignZip(tampered)).toThrow(CampaignSchemaError)
  })

  it('schema 校验失败 → throw CampaignSchemaError（不加载损坏包）', () => {
    const p = makeValidPayload()
    // 制造 schema 非法：map.gridType
    p.map.gridType = 'invalid' as never
    const zipBytes = buildCampaignZip(p)
    expect(() => loadCampaignZip(zipBytes)).toThrow(CampaignSchemaError)
  })
})

// =============================================================================
// 4. 凡尔登包：schema 校验 + 一致性 + buildInitialWorldState + 开局
// =============================================================================

describe('凡尔登默认示例包', () => {
  it('通过 schema 校验', () => {
    expect(() => validateCampaignPayload(verdunCampaign)).not.toThrow()
  })

  it('通过跨文件一致性校验', () => {
    expect(() => validateCampaignConsistency(verdunCampaign)).not.toThrow()
  })

  it('schemaVersion 为 1.0.0', () => {
    expect(verdunCampaign.manifest.schemaVersion).toBe('1.0.0')
  })

  it('manifest.playerFactionIds 含法/德', () => {
    expect(verdunCampaign.manifest.playerFactionIds).toEqual(
      expect.arrayContaining(['france', 'germany']),
    )
  })

  it('含四员指挥官（贝当/尼韦勒/法金汉/皇太子）', () => {
    const names = verdunCampaign.commanders.map((c) => c.id)
    expect(names).toEqual(
      expect.arrayContaining(['petain', 'nivelle', 'falkenhayn', 'crown-prince']),
    )
  })

  it('人格数值合理：贝当 aggression 低 obedience 高', () => {
    const petain = verdunCampaign.commanders.find((c) => c.id === 'petain')!
    expect(petain.aggression).toBeLessThan(0.4)
    expect(petain.obedience).toBeGreaterThan(0.7)
    expect(petain.preferredTempo).toBe('methodical')
  })

  it('人格数值合理：尼韦勒 aggression 高', () => {
    const nivelle = verdunCampaign.commanders.find((c) => c.id === 'nivelle')!
    expect(nivelle.aggression).toBeGreaterThan(0.7)
    expect(nivelle.preferredTempo).toBe('rapid')
  })

  it('人格数值合理：法金汉 methodical + aggression 中', () => {
    const falkenhayn = verdunCampaign.commanders.find((c) => c.id === 'falkenhayn')!
    expect(falkenhayn.aggression).toBeGreaterThanOrEqual(0.4)
    expect(falkenhayn.aggression).toBeLessThanOrEqual(0.6)
    expect(falkenhayn.preferredTempo).toBe('methodical')
  })

  it('规则 halfLifeTurns=3（情报半衰草案）', () => {
    expect(verdunCampaign.rules.intelDecay.halfLifeTurns).toBe(3)
  })

  it('含高价值节点杜奥蒙堡/沃堡/苏维尔堡/凡尔登城', () => {
    const nodeIds = verdunCampaign.map.highValueNodes.map((n) => n.id)
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        'fort-douaumont',
        'fort-vaux',
        'fort-souville',
        'verdun-city',
      ]),
    )
  })

  it('胜利条件含法/德双方（消耗与占领）', () => {
    const factionIds = verdunCampaign.victory.conditions.map((c) => c.factionId)
    expect(factionIds).toEqual(expect.arrayContaining(['france', 'germany']))
    const types = verdunCampaign.victory.conditions.map((c) => c.type)
    expect(types).toEqual(expect.arrayContaining(['objective', 'casualty', 'turn_limit']))
  })
})

describe('buildInitialWorldState（凡尔登投影）', () => {
  it('投影出合法 WorldState（turnIndex=0，含阵营/单位/地图）', () => {
    const world = buildInitialWorldState(verdunCampaign, 'save-1', 'france')
    expect(world.saveId).toBe('save-1')
    expect(world.scenarioId).toBe('verdun-1916')
    expect(world.scenarioSeed).toBe(verdunCampaign.manifest.scenarioSeed)
    expect(world.turnIndex).toBe(0)
    expect(world.inGameDate).toBe('1916-02-21')
    expect(world.factions).toHaveLength(2)
    expect(world.units.length).toBeGreaterThan(0)
    expect(world.map.cols).toBe(verdunCampaign.map.cols)
    expect(world.intel.decayRule.halfLifeTurns).toBe(3)
  })

  it('阵营 commander 已解析为 CommanderProfile', () => {
    const world = buildInitialWorldState(verdunCampaign, 'save-1', 'france')
    const france = world.factions.find((f) => f.id === 'france')!
    expect(france.commander.id).toBe('petain')
    expect(france.commander.aggression).toBeLessThan(0.4)
    // 战区司令（尼韦勒）
    expect(france.theaterCommanders.map((c) => c.id)).toContain('nivelle')
  })

  it('单位 detection：己方 L3 全量透视，敌方 L0 盲区', () => {
    const world = buildInitialWorldState(verdunCampaign, 'save-1', 'france')
    const frUnit = world.units.find((u) => u.factionId === 'france')!
    expect(frUnit.detection['france'].level).toBe(3)
    expect(frUnit.detection['germany'].level).toBe(0)
    const deUnit = world.units.find((u) => u.factionId === 'germany')!
    expect(deUnit.detection['germany'].level).toBe(3)
    expect(deUnit.detection['france'].level).toBe(0)
  })

  it('非法 playerFactionId → throw CampaignConsistencyError', () => {
    expect(() =>
      buildInitialWorldState(verdunCampaign, 'save-1', 'nonexistent'),
    ).toThrow(CampaignConsistencyError)
  })

  // ===========================================================================
  // 视角 bug 回归：选德军开局时 faction.side 正确 swap、playerFactionId 写入
  // 根因：剧本角色位 france.side='player'/germany.side='enemy' 硬编码，
  // 选 germany 不 swap → 所有用 side==='player' 判断的代码把 france 当玩家。
  // ===========================================================================
  it('选默认方（france）→ playerFactionId 写入，side 不变', () => {
    const world = buildInitialWorldState(verdunCampaign, 'save-fr', 'france')
    expect(world.playerFactionId).toBe('france')
    expect(world.factions.find((f) => f.id === 'france')!.side).toBe('player')
    expect(world.factions.find((f) => f.id === 'germany')!.side).toBe('enemy')
  })

  it('选德军（germany）→ side swap：germany=player，france=enemy；playerFactionId=germany', () => {
    const world = buildInitialWorldState(verdunCampaign, 'save-de', 'germany')
    // 显式字段写入（getPlayerFactionId 优先读此字段）
    expect(world.playerFactionId).toBe('germany')
    // side swap：选中方→player，原 player 方→enemy（凡尔登法-德 at_war）
    expect(world.factions.find((f) => f.id === 'germany')!.side).toBe('player')
    expect(world.factions.find((f) => f.id === 'france')!.side).toBe('enemy')
    // 旧路径（fallback side==='player'）也返回 germany（side swap 保证一致）
    const fallbackPlayer = world.factions.find((f) => f.side === 'player')
    expect(fallbackPlayer?.id).toBe('germany')
  })
})

describe('startCampaignFromPayload（凡尔登开局，gateway mock）', () => {
  it('调 fs_init_save + fs_write_world_state 各一次', async () => {
    const world = await startCampaignFromPayload(
      verdunCampaign,
      'save-start',
      'germany',
    )
    expect(world.saveId).toBe('save-start')
    expect(world.scenarioId).toBe('verdun-1916')
    expect(mockFs.initSaveCalls).toHaveLength(1)
    expect(mockFs.initSaveCalls[0].saveId).toBe('save-start')
    expect(mockFs.writeWorldStateCalls).toHaveLength(1)
    expect(mockFs.writeWorldStateCalls[0].saveId).toBe('save-start')
    // manifest 含 playerFactionId
    const manifest = JSON.parse(mockFs.initSaveCalls[0].manifest)
    expect(manifest.playerFactionId).toBe('germany')
  })

  it('startDefaultCampaign 默认选 france 开局', async () => {
    mockFs.initSaveCalls.length = 0
    mockFs.writeWorldStateCalls.length = 0
    const world = await startDefaultCampaign('save-default')
    expect(world.scenarioId).toBe('verdun-1916')
    const manifest = JSON.parse(mockFs.initSaveCalls[0].manifest)
    expect(manifest.playerFactionId).toBe('france')
  })
})

// =============================================================================
// 5. 跨文件一致性校验
// =============================================================================

describe('validateCampaignConsistency 跨文件引用', () => {
  it('faction.commanderId 引用不存在指挥官 → throw', () => {
    const p = makeValidPayload()
    p.factions[0].commanderId = 'ghost-commander'
    expect(() => validateCampaignConsistency(p)).toThrow(CampaignConsistencyError)
  })

  it('unit.factionId 引用不存在阵营 → throw', () => {
    const p = makeValidPayload()
    p.units[0].factionId = 'ghost-faction'
    expect(() => validateCampaignConsistency(p)).toThrow(CampaignConsistencyError)
  })

  it('unit.coord 超出地图范围 → throw', () => {
    const p = makeValidPayload()
    p.units[0].coord = { col: 999, row: 999 }
    expect(() => validateCampaignConsistency(p)).toThrow(CampaignConsistencyError)
  })

  it('victory.nodeId 引用不存在节点 → throw', () => {
    const p = makeValidPayload()
    const objectiveCond = p.victory.conditions.find((c) => c.type === 'objective')!
    objectiveCond.nodeId = 'ghost-node'
    expect(() => validateCampaignConsistency(p)).toThrow(CampaignConsistencyError)
  })

  it('manifest.playerFactionIds 引用不存在阵营 → throw', () => {
    const p = makeValidPayload()
    p.manifest.playerFactionIds = ['france', 'ghost-faction']
    expect(() => validateCampaignConsistency(p)).toThrow(CampaignConsistencyError)
  })
})

// =============================================================================
// 6. 内置战役包校验（官渡/俄乌/中途岛/美以伊）
//
// 每个内置包必须通过 schema 校验 + 跨文件一致性校验 + ZIP 闭环，
// 并校验关键史实字段（scenarioId/阵营/指挥官人格/胜负条件）。
// =============================================================================

/** 内置包参数化校验：schema + 一致性 + ZIP 闭环三连 */
function assertBuiltinCampaignValid(
  payload: CampaignPayload,
  expected: {
    scenarioId: string
    playerFactionIds: string[]
    factionCount: number
  },
): void {
  // schema 校验
  expect(() => validateCampaignPayload(payload)).not.toThrow()
  // 跨文件一致性校验
  expect(() => validateCampaignConsistency(payload)).not.toThrow()
  // schemaVersion
  expect(payload.manifest.schemaVersion).toBe('1.0.0')
  // scenarioId / playerFactionIds
  expect(payload.manifest.scenarioId).toBe(expected.scenarioId)
  expect(payload.manifest.playerFactionIds).toEqual(
    expect.arrayContaining(expected.playerFactionIds),
  )
  // 阵营数
  expect(payload.factions).toHaveLength(expected.factionCount)
  // 至少一员指挥官 + 至少一个单位 + 至少一个高价值节点
  expect(payload.commanders.length).toBeGreaterThanOrEqual(1)
  expect(payload.units.length).toBeGreaterThanOrEqual(1)
  expect(payload.map.highValueNodes.length).toBeGreaterThanOrEqual(1)
  // 胜负条件至少含双方阵营
  const victoryFactions = payload.victory.conditions.map((c) => c.factionId)
  for (const fid of expected.playerFactionIds) {
    expect(victoryFactions).toContain(fid)
  }
  // ZIP 闭环：打包再解包字段一致
  const zipBytes = buildCampaignZip(payload)
  const roundtrip = loadCampaignZip(zipBytes)
  expect(roundtrip.manifest).toEqual(payload.manifest)
  expect(roundtrip.map).toEqual(payload.map)
  expect(roundtrip.factions).toEqual(payload.factions)
  expect(roundtrip.units).toEqual(payload.units)
  expect(roundtrip.commanders).toEqual(payload.commanders)
  expect(roundtrip.rules).toEqual(payload.rules)
  expect(roundtrip.victory).toEqual(payload.victory)
}

describe('内置战役包：官渡之战 200', () => {
  it('通过 schema + 一致性 + ZIP 闭环校验', () => {
    assertBuiltinCampaignValid(guanduCampaign, {
      scenarioId: 'guandu-200',
      playerFactionIds: ['caocao', 'yuanshao'],
      factionCount: 2,
    })
  })

  it('含官渡大营/乌巢粮仓高价值节点', () => {
    const nodeIds = guanduCampaign.map.highValueNodes.map((n) => n.id)
    expect(nodeIds).toEqual(
      expect.arrayContaining(['guandu-camp', 'wuchao-granary']),
    )
  })

  it('曹操人格：aggression 0.6 / obedience 1.0 / methodical', () => {
    const caocao = guanduCampaign.commanders.find((c) => c.id === 'caocao-lord')!
    expect(caocao.aggression).toBe(0.6)
    expect(caocao.obedience).toBe(1.0)
    expect(caocao.preferredTempo).toBe('methodical')
  })

  it('袁绍人格：aggression 0.3 / obedience 0.4（优柔寡断）', () => {
    const yuan = guanduCampaign.commanders.find((c) => c.id === 'yuanshao-lord')!
    expect(yuan.aggression).toBe(0.3)
    expect(yuan.obedience).toBe(0.4)
  })

  it('rules 含许攸来投事件 + 奇袭乌巢决策', () => {
    const eventIds = guanduCampaign.rules.randomEvents?.map((e) => e.id) ?? []
    expect(eventIds).toContain('xuyou-defect')
    const decisionIds = guanduCampaign.rules.decisions?.map((d) => d.id) ?? []
    expect(decisionIds).toContain('raid-wuchao')
  })

  it('胜负：曹=守至回合上限或重创袁军；袁=占官渡大营', () => {
    const types = guanduCampaign.victory.conditions.map((c) => c.type)
    expect(types).toEqual(expect.arrayContaining(['turn_limit', 'casualty', 'objective']))
    const objCond = guanduCampaign.victory.conditions.find(
      (c) => c.type === 'objective' && c.factionId === 'yuanshao',
    )
    expect(objCond?.nodeId).toBe('guandu-camp')
  })
})

describe('内置战役包：俄乌冲突 2022', () => {
  it('通过 schema + 一致性 + ZIP 闭环校验', () => {
    assertBuiltinCampaignValid(ukraineCampaign, {
      scenarioId: 'ukraine-2022',
      playerFactionIds: ['ukraine', 'russia'],
      factionCount: 2,
    })
  })

  it('地图 16×12，含基辅/哈尔科夫/赫尔松/顿涅茨克/马里乌波尔节点', () => {
    expect(ukraineCampaign.map.cols).toBe(16)
    expect(ukraineCampaign.map.rows).toBe(12)
    const nodeIds = ukraineCampaign.map.highValueNodes.map((n) => n.id)
    expect(nodeIds).toEqual(
      expect.arrayContaining(['kyiv', 'kharkiv', 'kherson', 'donetsk', 'mariupol']),
    )
  })

  it('daysPerTurn=3（战争节奏较快）', () => {
    expect(ukraineCampaign.manifest.daysPerTurn).toBe(3)
  })

  it('泽连斯基人格：aggression 0.7 / obedience 0.9 / rapid', () => {
    const zelensky = ukraineCampaign.commanders.find((c) => c.id === 'zelensky')!
    expect(zelensky.aggression).toBe(0.7)
    expect(zelensky.obedience).toBe(0.9)
    expect(zelensky.preferredTempo).toBe('rapid')
  })

  it('rules supply.severedMultiplier=2.0（俄军长补给线脆弱）', () => {
    expect(ukraineCampaign.rules.supply?.severedMultiplier).toBe(2.0)
  })

  it('rules 含西方军援事件 + 基辅防御决策', () => {
    const eventIds = ukraineCampaign.rules.randomEvents?.map((e) => e.id) ?? []
    expect(eventIds).toContain('western-aid')
    const decisionIds = ukraineCampaign.rules.decisions?.map((d) => d.id) ?? []
    expect(decisionIds).toContain('kyiv-defense')
  })

  it('单位数：乌军 10 + 俄军 13', () => {
    const ukr = ukraineCampaign.units.filter((u) => u.factionId === 'ukraine')
    const rus = ukraineCampaign.units.filter((u) => u.factionId === 'russia')
    expect(ukr).toHaveLength(10)
    expect(rus).toHaveLength(13)
  })
})

describe('内置战役包：中途岛海战 1942', () => {
  it('通过 schema + 一致性 + ZIP 闭环校验', () => {
    assertBuiltinCampaignValid(midwayCampaign, {
      scenarioId: 'midway-1942',
      playerFactionIds: ['usa', 'japan'],
      factionCount: 2,
    })
  })

  it('maxTurns=10（短战役）', () => {
    expect(midwayCampaign.manifest.maxTurns).toBe(10)
    expect(midwayCampaign.victory.maxTurns).toBe(10)
  })

  it('含中途岛高价值节点', () => {
    const nodeIds = midwayCampaign.map.highValueNodes.map((n) => n.id)
    expect(nodeIds).toContain('midway')
  })

  it('尼米兹人格：aggression 0.8 / methodical（情报至上）', () => {
    const nimitz = midwayCampaign.commanders.find((c) => c.id === 'nimitz')!
    expect(nimitz.aggression).toBe(0.8)
    expect(nimitz.preferredTempo).toBe('methodical')
  })

  it('rules combat.attritionRate=0.15（海战消耗高）', () => {
    expect(midwayCampaign.rules.combat.attritionRate).toBe(0.15)
  })

  it('rules 含 JN-25 破译 + 南云换弹危机事件', () => {
    const eventIds = midwayCampaign.rules.randomEvents?.map((e) => e.id) ?? []
    expect(eventIds).toEqual(
      expect.arrayContaining(['decrypt-jn25', 'nakagawa-rearm']),
    )
  })

  it('单位数：美军 8 + 日军 10', () => {
    const usa = midwayCampaign.units.filter((u) => u.factionId === 'usa')
    const japan = midwayCampaign.units.filter((u) => u.factionId === 'japan')
    expect(usa).toHaveLength(8)
    expect(japan).toHaveLength(10)
  })

  it('胜负：美=重创日军（casualtyThreshold 0.4）；日=占中途岛', () => {
    const usaCasualty = midwayCampaign.victory.conditions.find(
      (c) => c.factionId === 'usa' && c.type === 'casualty',
    )
    expect(usaCasualty?.targetFactionId).toBe('japan')
    expect(usaCasualty?.casualtyThreshold).toBe(0.4)
    const japanObj = midwayCampaign.victory.conditions.find(
      (c) => c.factionId === 'japan' && c.type === 'objective',
    )
    expect(japanObj?.nodeId).toBe('midway')
  })
})

describe('内置战役包：美以伊冲突 2026', () => {
  it('通过 schema + 一致性 + ZIP 闭环校验', () => {
    assertBuiltinCampaignValid(iranCampaign, {
      scenarioId: 'iran-2026',
      playerFactionIds: ['usisrael', 'iran'],
      factionCount: 2,
    })
  })

  it('地图 16×12，含纳坦兹/福特罗/德黑兰/霍尔木兹节点', () => {
    expect(iranCampaign.map.cols).toBe(16)
    expect(iranCampaign.map.rows).toBe(12)
    const nodeIds = iranCampaign.map.highValueNodes.map((n) => n.id)
    expect(nodeIds).toEqual(
      expect.arrayContaining(['natanz', 'fordow', 'tehran', 'hormuz']),
    )
  })

  it('daysPerTurn=2', () => {
    expect(iranCampaign.manifest.daysPerTurn).toBe(2)
  })

  it('内塔尼亚胡人格：aggression 0.8 / rapid（先发制人）', () => {
    const netanyahu = iranCampaign.commanders.find((c) => c.id === 'netanyahu')!
    expect(netanyahu.aggression).toBe(0.8)
    expect(netanyahu.preferredTempo).toBe('rapid')
  })

  it('rules 含伊朗弹道导弹反击事件（turn_in 2/5/8）', () => {
    const evt = iranCampaign.rules.randomEvents?.find((e) => e.id === 'iran-retaliation')
    expect(evt).toBeDefined()
    expect(evt?.triggerCondition?.kind).toBe('turn_in')
    expect(evt?.triggerCondition?.turns).toEqual([2, 5, 8])
  })

  it('rules 含打击核设施决策', () => {
    const decisionIds = iranCampaign.rules.decisions?.map((d) => d.id) ?? []
    expect(decisionIds).toContain('strike-nuclear')
  })

  it('单位数：美以 9 + 伊朗 9', () => {
    const usisrael = iranCampaign.units.filter((u) => u.factionId === 'usisrael')
    const iran = iranCampaign.units.filter((u) => u.factionId === 'iran')
    expect(usisrael).toHaveLength(9)
    expect(iran).toHaveLength(9)
  })

  it('胜负：美以=摧毁纳坦兹+福特罗；伊朗=重创美军（战损 0.45）', () => {
    const natanzCond = iranCampaign.victory.conditions.find(
      (c) => c.id === 'usisrael-destroy-natanz',
    )
    expect(natanzCond?.nodeId).toBe('natanz')
    const fordowCond = iranCampaign.victory.conditions.find(
      (c) => c.id === 'usisrael-destroy-fordow',
    )
    expect(fordowCond?.nodeId).toBe('fordow')
    const iranCasualty = iranCampaign.victory.conditions.find(
      (c) => c.factionId === 'iran' && c.type === 'casualty',
    )
    expect(iranCasualty?.targetFactionId).toBe('usisrael')
    expect(iranCasualty?.casualtyThreshold).toBe(0.45)
  })
})

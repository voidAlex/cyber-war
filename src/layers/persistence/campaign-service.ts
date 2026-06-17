/**
 * 战役服务（campaign-service.ts）— 战役包 → 初始 WorldState → 存档开局编排。
 *
 * 职责：
 * - startCampaignFromPayload(payload)：把战役包七文件投影成初始 WorldState，
 *   经 saveRepository.initSave + writeWorldState 落盘开局。
 * - startDefaultCampaign()：便捷开局凡尔登默认示例包。
 *
 * 跨文件一致性校验（schema 层不负责）：commanderId/factionId/unit.factionId 引用必须存在。
 *
 * 本服务不直接 import @tauri-apps/api（铁律：gateway 唯一 import 层）。
 *
 * @module layers/persistence/campaign-service
 */

import type {
  CampaignPayload,
  WorldState,
  Faction,
  Unit,
  IntelObservation,
} from '@/types'
import { saveRepository } from '@/layers/persistence/repository'
import { validateCampaignPayload } from '@/layers/persistence/campaign-zip'
import { verdunCampaign } from '@/data/verdun-1916'
import { trustRecordFromValue } from '@/layers/domain/diplomacy'

// =============================================================================
// 跨文件一致性校验（schema 层之上的引用完整性）
// =============================================================================

/** 战役包引用一致性错误 */
export class CampaignConsistencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CampaignConsistencyError'
  }
}

/**
 * 校验战役包跨文件引用一致性（schema 层之上的完整性检查）。
 *
 * - 每个 faction.commanderId 必须在 commanders 中存在。
 * - 每个 faction.theaterCommanderIds[] 必须在 commanders 中存在。
 * - 每个 unit.factionId 必须在 factions 中存在。
 * - 每个 unit.coord 必须落在 map 网格范围内。
 * - 每个 victory condition.nodeId（如有）必须在 highValueNodes 中存在。
 * - playerFactionIds 必须全部在 factions 中存在。
 *
 * @param payload 七文件聚合
 * @throws CampaignConsistencyError 任一引用不一致
 */
export function validateCampaignConsistency(payload: CampaignPayload): void {
  const { manifest, map, factions, units, commanders, victory } = payload

  const factionIds = new Set(factions.map((f) => f.id))
  const commanderIds = new Set(commanders.map((c) => c.id))
  const nodeIds = new Set(map.highValueNodes.map((n) => n.id))

  // manifest.playerFactionIds 必须存在于 factions
  for (const fid of manifest.playerFactionIds) {
    if (!factionIds.has(fid)) {
      throw new CampaignConsistencyError(
        `manifest.playerFactionIds 引用了不存在的阵营: ${fid}`,
      )
    }
  }

  // faction.commanderId / theaterCommanderIds 必须存在
  for (const f of factions) {
    if (!commanderIds.has(f.commanderId)) {
      throw new CampaignConsistencyError(
        `阵营 ${f.id}.commanderId 引用了不存在的指挥官: ${f.commanderId}`,
      )
    }
    for (const tcId of f.theaterCommanderIds ?? []) {
      if (!commanderIds.has(tcId)) {
        throw new CampaignConsistencyError(
          `阵营 ${f.id}.theaterCommanderIds 引用了不存在的指挥官: ${tcId}`,
        )
      }
    }
  }

  // unit.factionId 必须存在；coord 必须落在网格内
  for (const u of units) {
    if (!factionIds.has(u.factionId)) {
      throw new CampaignConsistencyError(
        `单位 ${u.id}.factionId 引用了不存在的阵营: ${u.factionId}`,
      )
    }
    if (u.coord.col < 0 || u.coord.col >= map.cols || u.coord.row < 0 || u.coord.row >= map.rows) {
      throw new CampaignConsistencyError(
        `单位 ${u.id}.coord (${u.coord.col},${u.coord.row}) 超出地图范围 (${map.cols}×${map.rows})`,
      )
    }
  }

  // victory.nodeId 必须存在于 highValueNodes
  for (const cond of victory.conditions) {
    if (cond.type === 'objective' && cond.nodeId && !nodeIds.has(cond.nodeId)) {
      throw new CampaignConsistencyError(
        `胜利条件 ${cond.id}.nodeId 引用了不存在的高价值节点: ${cond.nodeId}`,
      )
    }
    if (cond.type === 'casualty' && cond.targetFactionId && !factionIds.has(cond.targetFactionId)) {
      throw new CampaignConsistencyError(
        `胜利条件 ${cond.id}.targetFactionId 引用了不存在的阵营: ${cond.targetFactionId}`,
      )
    }
  }
}

// =============================================================================
// buildInitialWorldState：CampaignPayload → 初始 WorldState
// =============================================================================

/**
 * 把战役包七文件投影成初始 WorldState（开局第 0 回合）。
 *
 * 投影规则：
 * - manifest → saveId/scenarioId/scenarioSeed/turnIndex=0/inGameDate
 * - map → world.map（直接复用 cells/highValueNodes/gridType/cols/rows）
 * - factions → world.factions（commanderId 解析为 CommanderProfile，theaterCommanderIds 同理）
 * - units → world.units（detection 初始化：己方 L3 全量，敌方 L0 盲区）
 * - rules.intelDecay → world.intel.decayRule
 * - 其余字段（diplomacy/directorMemory/pendingOrders/lockedOrders/...）初始化为空。
 *
 * @param payload 七文件聚合
 * @param saveId 存档 id（注入，通常由 UI 生成）
 * @param playerFactionId 玩家所选阵营 id（必须 ∈ manifest.playerFactionIds）
 */
export function buildInitialWorldState(
  payload: CampaignPayload,
  saveId: string,
  playerFactionId: string,
): WorldState {
  // 二次保险：投影前再校验 schema + 一致性（即便调用方已校验）
  validateCampaignPayload(payload)
  validateCampaignConsistency(payload)

  if (!payload.manifest.playerFactionIds.includes(playerFactionId)) {
    throw new CampaignConsistencyError(
      `playerFactionId ${playerFactionId} 不在 manifest.playerFactionIds 中`,
    )
  }

  const commanderById = new Map(payload.commanders.map((c) => [c.id, c]))

  // 阵营投影：解析 commanderId → CommanderProfile，theaterCommanderIds → CommanderProfile[]
  const factions: Faction[] = payload.factions.map((f) => {
    const commander = commanderById.get(f.commanderId)
    if (!commander) {
      // validateCampaignConsistency 已保证存在，此处仅类型收窄
      throw new CampaignConsistencyError(`阵营 ${f.id} 缺指挥官 ${f.commanderId}`)
    }
    const theaterCommanders = (f.theaterCommanderIds ?? [])
      .map((id) => commanderById.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => toCommanderProfile(c))
    // M4-D：trust 数值 + 并行 trustRecords 富语义记录。
    // 开局按 trust 数值兜底构造（honored/broken=0、lastChangeTurn=0），趋势恒 stable。
    const trustNums = { ...(f.trust ?? {}) }
    const trustRecords: NonNullable<Faction['trustRecords']> = {}
    for (const [otherId, value] of Object.entries(trustNums)) {
      trustRecords[otherId] = trustRecordFromValue(value)
    }
    return {
      id: f.id,
      name: f.name,
      color: f.color,
      side: f.side,
      commander: toCommanderProfile(commander),
      theaterCommanders,
      supply: { ...f.supply },
      trust: trustNums,
      trustRecords,
      // 第 5 批：定性关系（多阵营支撑）映射到 runtime Faction.relations
      relations: f.relations ? { ...f.relations } : undefined,
      doctrineTags: [...f.doctrineTags],
      description: f.description,
      // T2 第 3 批：民心/国际舆论初值映射到 runtime Faction。
      // 缺省 publicWill=60 / internationalOpinion=50（由 campaign-service 显式注入，
      // 避免 domain 层重复兜底；旧战役包无此字段时走缺省）。
      publicWill: f.publicWill ?? 60,
      internationalOpinion: f.internationalOpinion ?? 50,
    }
  })

  // ===========================================================================
  // 视角 bug 修复：若玩家所选阵营 ≠ 剧本默认 player 方，swap faction.side。
  // 剧本角色位（如凡尔登 france.side='player'/germany.side='enemy'）是硬编码的，
  // 选 germany 开局时必须把 germany 改为 'player'、原 player 方（france）改为敌方，
  // 否则所有用 side==='player' 判断的代码（AI 编排/情报/外交/沙盘渲染/参谋长视角）
  // 都会错误地把剧本默认 player 方当作玩家。
  //
  // 规则：
  // - 选中阵营 → side='player'
  // - 原 player 方（若 ≠ 选中方）→ 改为它与选中方的关系决定的立场：
  //   at_war/hostile → 'enemy'；allied → 'ally'；neutral/缺失 → 'enemy'（默认敌对，符合凡尔登场景）
  // - 其余阵营保持剧本 side 不变（ally/neutral/enemy）
  // ===========================================================================
  if (playerFactionId.length > 0) {
    const defaultPlayer = factions.find((f) => f.side === 'player')
    const selected = factions.find((f) => f.id === playerFactionId)
    if (selected !== undefined && selected.id !== defaultPlayer?.id) {
      // swap：原 player 方降级为敌方/盟友
      if (defaultPlayer !== undefined) {
        const relToSelected = defaultPlayer.relations?.[playerFactionId]
        defaultPlayer.side = relToSelected === 'allied' ? 'ally' : 'enemy'
      }
      selected.side = 'player'
    }
  }

  const factionIds = new Set(factions.map((f) => f.id))

  // 单位投影：detection 初始化——己方 L3 全量透视，敌方 L0 盲区
  const units: Unit[] = payload.units.map((u) => {
    const detection: Record<string, IntelObservation> = {}
    for (const fid of factionIds) {
      detection[fid] = {
        observerFactionId: fid,
        level: fid === u.factionId ? 3 : 0,
        lastSeenTurn: fid === u.factionId ? 0 : -1,
        staleTurns: 0,
      }
    }
    return {
      id: u.id,
      factionId: u.factionId,
      type: u.type,
      coord: { col: u.coord.col, row: u.coord.row },
      strength: u.strength,
      personnel: u.personnel,
      maxPersonnel: u.maxPersonnel,
      fuel: u.fuel,
      ammo: u.ammo,
      morale: u.morale,
      fatigue: u.fatigue,
      detection,
      orders: [],
      status: [...(u.status ?? [])],
      // 第 5 批：装备槽映射（无装备=undefined，保持旧存档兼容）
      equipment:
        u.equipment && u.equipment.length > 0
          ? u.equipment.map((e) => ({
              type: e.type,
              count: e.count,
              quality: e.quality,
            }))
          : undefined,
      // T2 第 2 批：电子战能力映射（无 ewCapability=undefined，保持旧战役包兼容）。
      // entrenchment 缺省 0（旧存档兼容回填由 domain 层 ?? 0 兜底，CampaignUnit 无此字段）。
      ewCapability: u.ewCapability ? { ...u.ewCapability } : undefined,
    }
  })

  return {
    saveId,
    // 视角 bug 修复：显式持有玩家阵营 id（getPlayerFactionId 优先读此字段）。
    playerFactionId,
    scenarioId: payload.manifest.scenarioId,
    scenarioSeed: payload.manifest.scenarioSeed,
    turnIndex: 0,
    inGameDate: payload.manifest.startInGameDate ?? 'D-0',
    factions,
    units,
    map: {
      gridType: payload.map.gridType,
      cols: payload.map.cols,
      rows: payload.map.rows,
      cells: payload.map.cells.map((c) => ({ ...c })),
      highValueNodes: payload.map.highValueNodes.map((n) => ({ ...n })),
    },
    intel: {
      decayRule: {
        halfLifeTurns: payload.rules.intelDecay.halfLifeTurns,
        decayPerHalfLife: payload.rules.intelDecay.decayPerHalfLife,
      },
      reconHits: [],
    },
    diplomacy: {
      events: [],
      pendingDefectionCheck: false,
    },
    directorMemory: {
      keyEvents: {},
      overrides: [],
    },
    pendingOrders: [],
    lockedOrders: {},
    lastResolution: null,
    contextSummaries: {},
  }
}

/** CampaignCommander → CommanderProfile（types/faction 接口） */
function toCommanderProfile(c: CampaignPayload['commanders'][number]): Faction['commander'] {
  return {
    id: c.id,
    name: c.name,
    personality: c.personality,
    aggression: c.aggression,
    obedience: c.obedience,
    preferredTempo: c.preferredTempo,
    doctrineTags: [...c.doctrineTags],
  }
}

// =============================================================================
// startCampaignFromPayload：payload → 存档开局（initSave + 写初始 world-state）
// =============================================================================

/**
 * 从战役包 payload 开局：校验 → 构造初始 WorldState → initSave + 写 world-state。
 *
 * 流程：
 * 1. validateCampaignPayload（schema 校验，失败 throw）
 * 2. validateCampaignConsistency（引用一致性，失败 throw）
 * 3. buildInitialWorldState（投影为 WorldState）
 * 4. saveRepository.initSave（创建目录 + 写 manifest）
 * 5. saveRepository.writeWorldState（写初始 world-state.json）
 *
 * @param payload 七文件聚合
 * @param saveId 存档 id
 * @param playerFactionId 玩家所选阵营（∈ manifest.playerFactionIds）
 * @returns 初始 WorldState（UI 据此载入上下文）
 */
export async function startCampaignFromPayload(
  payload: CampaignPayload,
  saveId: string,
  playerFactionId: string,
): Promise<WorldState> {
  const world = buildInitialWorldState(payload, saveId, playerFactionId)
  const manifest = saveRepository.buildDefaultManifest({
    saveId,
    scenarioId: world.scenarioId,
    displayName: payload.manifest.displayName,
    turnIndex: world.turnIndex,
    phase: 'idle',
  })
  manifest.playerFactionId = playerFactionId
  await saveRepository.initSave(saveId, manifest)
  await saveRepository.writeWorldState(saveId, world)
  return world
}

/**
 * 便捷：用凡尔登默认示例包开局。
 *
 * @param saveId 存档 id
 * @param playerFactionId 法/德（默认 france 守方）
 */
export async function startDefaultCampaign(
  saveId: string,
  playerFactionId: string = 'france',
): Promise<WorldState> {
  return startCampaignFromPayload(verdunCampaign, saveId, playerFactionId)
}

/**
 * 持久化服务（persistence-service.ts）— 副作用出口（orchestrator 调用）。
 *
 * 封装 world-state.json 原子读写、event-log 真追加、manifest 同步。
 * 经 @gateway/tauri-bridge 调 Rust fs_* 命令；本服务不直接 import @tauri-apps/api
 * （铁律：gateway 是唯一 import @tauri-apps/api 的层）。
 *
 * 关键防坑（重写计划）：writeTurn 中 world-state 原子写 + 事件追加均为 await
 * （非 fire-and-forget），保证 orchestrator 推进前已落盘。
 *
 * @module layers/application/services/persistence-service
 */

import type {
  WorldState,
  SaveManifest,
  AgentAction,
  GamePhase,
} from '@/types'
import { saveRepository } from '@/layers/persistence/repository'
import { appendEvents } from '@/layers/persistence/event-log'

/**
 * 持久化服务接口（供 orchestrator 依赖注入，便于 mock 测试）。
 */
export interface PersistenceService {
  /** 写 world-state.json（原子） */
  writeWorldState(saveId: string, world: WorldState): Promise<void>
  /** 读 world-state.json（不存在返回 null） */
  readWorldState(saveId: string): Promise<WorldState | null>
  /** 列出存档 id */
  listSaves(): Promise<string[]>
  /** 创建新存档（init 目录 + 写 manifest + 写初始 world-state） */
  createSave(params: {
    saveId: string
    scenarioId: string
    displayName: string
  }): Promise<WorldState>
  /** 删除存档 */
  deleteSave(saveId: string): Promise<void>
  /** 写一个回合：原子写 world-state + 追加事件 + 同步 manifest（全部 await） */
  writeTurn(world: WorldState, phase: GamePhase, events?: AgentAction[]): Promise<void>
  /** 读 manifest（用于存档列表展示） */
  readManifest(saveId: string): Promise<SaveManifest | null>
}

/**
 * 默认持久化服务实现（经 gateway 调真实 fs_* 命令）。
 *
 * orchestrator 通过依赖注入持有此实例；测试时可注入 mock。
 */
export const persistenceService: PersistenceService = {
  async writeWorldState(saveId, world) {
    await saveRepository.writeWorldState(saveId, world)
  },

  async readWorldState(saveId) {
    return saveRepository.getWorldState(saveId)
  },

  async listSaves() {
    return saveRepository.listSaveIds()
  },

  async createSave({ saveId, scenarioId, displayName }) {
    // 1. 构造初始空 world-state（M1 空回合演示用空世界）
    const world = createEmptyWorldState(saveId, scenarioId)
    // 2. 构造 manifest
    const manifest = saveRepository.buildDefaultManifest({
      saveId,
      scenarioId,
      displayName,
      turnIndex: world.turnIndex,
      phase: 'idle',
    })
    // 3. init 存档目录 + 写 manifest
    await saveRepository.initSave(saveId, manifest)
    // 4. 写初始 world-state（首次创建即落盘，保证刷新可恢复）
    await saveRepository.writeWorldState(saveId, world)
    return world
  },

  async deleteSave(saveId) {
    await saveRepository.deleteSave(saveId)
  },

  async writeTurn(world, phase, events = []) {
    const saveId = world.saveId
    // 1. 原子写 world-state.json（await，非 fire-and-forget）
    await saveRepository.writeWorldState(saveId, world)
    // 2. 追加本回合事件到 event-log.jsonl（await，真追加 O(1)）
    if (events.length > 0) {
      await appendEvents(saveId, events)
    }
    // 3. 同步 manifest（回合/阶段/更新时间）
    const manifest = saveRepository.buildDefaultManifest({
      saveId,
      scenarioId: world.scenarioId,
      displayName: saveId, // M1 暂用 saveId 作显示名兜底
      turnIndex: world.turnIndex,
      phase,
    })
    await saveRepository.writeManifest(saveId, manifest)
  },

  async readManifest(_saveId) {
    // M1 暂不单独读 manifest（manifest 在 listSaves 后由存档列表 UI 展示时读取，
    // 此处保留接口供 M2/M4 扩展）。当前返回 null。
    // TODO(M2): 经 gateway 读取 manifest.json 并解析。
    return null
  },
}

/**
 * 创建 M1 空世界状态（空阵营/空单位/空地图，仅设 saveId/scenarioId/turnIndex）。
 *
 * M1 空回合演示无需真实阵营/单位/地图；此函数产出最小合法 WorldState，
 * 后续里程碑由战役包加载真实数据。
 *
 * @param saveId 存档 id
 * @param scenarioId 场景 id
 */
export function createEmptyWorldState(saveId: string, scenarioId: string): WorldState {
  return {
    saveId,
    // M1 空存档无阵营，玩家阵营 id 为空串（WorldState 必需字段，避免类型缺失）。
    playerFactionId: '',
    scenarioId,
    scenarioSeed: `${scenarioId}:${saveId}`,
    turnIndex: 0,
    inGameDate: 'D-0',
    factions: [],
    units: [],
    map: {
      gridType: 'square',
      cols: 0,
      rows: 0,
      cells: [],
      highValueNodes: [],
    },
    intel: {
      decayRule: { halfLifeTurns: 3, decayPerHalfLife: 1 },
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

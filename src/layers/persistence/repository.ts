/**
 * 存档仓库（repository.ts）— world-state.json 唯一真相源入口。
 *
 * 封装存档级 CRUD（list/get/create/delete/load），编排 @gateway/tauri-bridge
 * 的 fs_* 命令。不直接 import @tauri-apps/api（铁律：gateway 唯一 import 层）。
 *
 * world-state.json 是游戏数据唯一真相源（重写计划「数据模型要点」），
 * 本仓库是其唯一读写入口；其余层经 persistence-service 编排。
 *
 * @module layers/persistence/repository
 */

import type { WorldState, SaveManifest } from '@/types'
import {
  fsReadWorldState,
  fsWriteWorldState,
  fsListSaves,
  fsInitSave,
  fsDeleteSave,
  fsWriteManifest,
} from '@/layers/gateway/tauri-bridge'
import { GAME_VERSION } from '@/types'

/**
 * 存档仓库（world-state 唯一真相源入口）。
 *
 * 所有方法均为 async（gateway invoke 是异步 IPC）。
 */
export const saveRepository = {
  /**
   * 列出所有存档 id（扫描 saves 根目录下含 manifest.json 的子目录）。
   */
  async listSaveIds(): Promise<string[]> {
    return fsListSaves()
  },

  /**
   * 读取某存档的 world-state（解析 JSON；不存在时返回 null）。
   *
   * @param saveId 存档 id
   * @returns WorldState 或 null（存档无 world-state.json）
   */
  async getWorldState(saveId: string): Promise<WorldState | null> {
    try {
      const raw = await fsReadWorldState(saveId)
      return JSON.parse(raw) as WorldState
    } catch {
      // 文件不存在或解析失败，返回 null（上层据 null 判定存档损坏/空）
      return null
    }
  },

  /**
   * 原子写入 world-state.json（经 gateway 调 fs_write_world_state 临时文件+rename）。
   *
   * @param saveId 存档 id
   * @param world 待写入的世界状态
   */
  async writeWorldState(saveId: string, world: WorldState): Promise<void> {
    const content = JSON.stringify(world)
    await fsWriteWorldState(saveId, content)
  },

  /**
   * 初始化新存档（创建目录 + 写 manifest）。
   *
   * @param saveId 存档 id
   * @param manifest 存档清单
   */
  async initSave(saveId: string, manifest: SaveManifest): Promise<void> {
    await fsInitSave(saveId, JSON.stringify(manifest))
  },

  /**
   * 更新存档 manifest（写 world-state 后同步回合/阶段/时间）。
   */
  async writeManifest(saveId: string, manifest: SaveManifest): Promise<void> {
    await fsWriteManifest(saveId, JSON.stringify(manifest))
  },

  /**
   * 删除存档（递归删除 saves/<saveId>）。
   */
  async deleteSave(saveId: string): Promise<void> {
    await fsDeleteSave(saveId)
  },

  /**
   * 构造默认 manifest（创建存档时用）。
   *
   * 注意：createdAt/updatedAt 用 Date.now()——manifest 是存档元信息（非游戏数据），
   * 不进入 reducer 确定性链路，允许时间戳。
   */
  buildDefaultManifest(params: {
    saveId: string
    scenarioId: string
    displayName: string
    turnIndex: number
    phase: string
  }): SaveManifest {
    const now = new Date().toISOString()
    return {
      saveId: params.saveId,
      scenarioId: params.scenarioId,
      displayName: params.displayName,
      turnIndex: params.turnIndex,
      phase: params.phase,
      createdAt: now,
      updatedAt: now,
      version: GAME_VERSION,
    }
  },
}

/**
 * 存档清单类型定义（SaveManifest）
 *
 * 存档根目录 saves/<saveId>/manifest.json 的结构。
 * 存档列表 UI（M1）读取此文件展示存档元信息。
 *
 * @module types/save-manifest
 */

/**
 * 存档清单接口。
 *
 * Rust 侧 `fs_init_save` / `fs_write_manifest` 接收序列化好的 manifest JSON 字符串，
 * Rust 不解析语义（铁律：fs 不解析游戏语义）。
 */
export interface SaveManifest {
  /** 存档唯一 id（= 目录名） */
  saveId: string
  /** 场景 id（如 verdun-1916） */
  scenarioId: string
  /** 显示名 */
  displayName: string
  /** 当前回合索引 */
  turnIndex: number
  /** 当前游戏阶段 */
  phase: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
  /** 存档格式版本（数据迁移用） */
  version: string
  /** 玩家所选阵营 id */
  playerFactionId?: string
}

/**
 * 存档列表项（UI 渲染用，由 SaveManifest 投影）。
 */
export interface SaveListItem {
  /** 存档 id */
  saveId: string
  /** 显示名 */
  displayName: string
  /** 场景 id */
  scenarioId: string
  /** 当前回合 */
  turnIndex: number
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
}

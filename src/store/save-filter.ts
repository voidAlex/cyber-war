/**
 * 存档过滤谓词（save-filter.ts）— 纯函数。
 *
 * 从 game-store 拆出，避免测试 import store 时触发 Worker 初始化
 * （store 模块顶层会 initWorkerService）。
 *
 * 过滤掉 runtime-config 占用的伪 saveId，不展示给玩家。
 *
 * 兼容旧版（去口令改造前）：去口令后 runtime-config 不再写伪 saveId
 * `__runtime_llm_config__`（改走 `<config>/llm-config.json`），但此处过滤保留
 * 兜底，防止升级用户的旧版残留目录混入存档列表。
 *
 * @module store/save-filter
 */

/** 伪 saveId（去口令前 runtime-config 占用，保留过滤兜底兼容旧版残留） */
export const RUNTIME_CONFIG_SAVE_ID = '__runtime_llm_config__'

/**
 * 存档 id 过滤谓词（纯函数）。
 * 过滤掉 runtime-config 占用的伪 saveId（兼容旧版残留），不展示给玩家。
 */
export function isPlayerSaveId(id: string): boolean {
  return id !== RUNTIME_CONFIG_SAVE_ID
}

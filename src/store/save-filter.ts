/**
 * 存档过滤谓词（save-filter.ts）— 纯函数。
 *
 * 从 game-store 拆出，避免测试 import store 时触发 Worker 初始化
 * （store 模块顶层会 initWorkerService）。
 *
 * 过滤掉 runtime-config 占用的伪 saveId，不展示给玩家。
 *
 * @module store/save-filter
 */

/** 伪 saveId（runtime-config 占用，不应出现在玩家存档列表） */
export const RUNTIME_CONFIG_SAVE_ID = '__runtime_llm_config__'

/**
 * 存档 id 过滤谓词（纯函数）。
 * 过滤掉 runtime-config 占用的伪 saveId，不展示给玩家。
 */
export function isPlayerSaveId(id: string): boolean {
  return id !== RUNTIME_CONFIG_SAVE_ID
}

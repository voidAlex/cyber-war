/**
 * 参谋长角色桩（chief.ts）。
 *
 * 参谋长负责：解析玩家自然语言命令 → 握手反问 → 预演虚线 → 玩家确认。
 * 批量握手取代逐条（重写计划修订点 B）。
 *
 * 里程碑：M2（mock 参谋长握手）/ M3（真 LLM 参谋长）。
 *
 * @module layers/agents/roles/chief
 */

/**
 * 参谋长桩。
 * TODO(M2/M3): 由后续子代理实现命令解析与批量握手。
 */
export function chiefRole(): void {
  // TODO(M2/M3): 命令解析 + 批量握手
}

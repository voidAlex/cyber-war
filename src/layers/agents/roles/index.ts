/**
 * Agent 角色层 barrel（chief/theater/commander/director）。
 *
 * M2：chief（mock 命令解析）/ director（mock 终裁）已填充。
 * M3：theater/commander 接入真 LLM，chief/director 可替换为真 LLM。
 *
 * @module layers/agents/roles
 */

export { chiefRole, createChiefRole } from './chief'
export type { ChiefRole, ChiefParseContext } from './chief'
export { theaterRole } from './theater'
export { commanderRole } from './commander'
export { directorRole, createDirectorRole } from './director'
export type { DirectorRole, DirectorAdjudicateParams, DirectorAdjudicateResult } from './director'

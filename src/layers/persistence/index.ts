/**
 * 持久化层 barrel（repository / event-log / snapshot / replay / campaign-zip / diagnostics）。
 *
 * 本层编排持久化逻辑，但 Tauri 调用一律走 @gateway/*（铁律：gateway 唯一 import
 * @tauri-apps/api）。
 *
 * @module layers/persistence
 */

export { saveRepository } from './repository'
export { appendEvent, appendEvents, readEventLog } from './event-log'
export { createTurnSnapshot, loadTurnSnapshot, writeSnapshot, readSnapshot } from './snapshot'
export { restoreFromEventLog, replayToLatest } from './replay'
export { unpackCampaign } from './campaign-zip'
export { appendDiagnostic } from './diagnostics'

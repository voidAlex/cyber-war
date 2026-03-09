/**
 * 存储层导出
 * 
 * @module storage
 */

// OPFS 基础操作
export {
  getOPFSRoot,
  initializeSaveDirectory,
  getSaveDirectory,
  listSaves,
  atomicWriteFile,
  readFile,
  readJSONFile,
  writeJSONFile,
  appendToFile,
  deleteFile,
  deleteSave,
  checkStorageQuota,
  generateSaveId,
  generateScenarioSeed,
  OPFSError,
} from './opfs'

// 游戏状态存储
export {
  createNewGame,
  loadGame,
  saveGame,
  createTurnSnapshot,
  loadTurnSnapshot,
  appendEventLog,
  logDiagnostic,
  logDiagnosticBySaveId,
  getSaveManifest,
  savePendingOrdersByFaction,
  loadPendingOrdersByFaction,
  deleteGame,
  generateEventId,
} from './game-storage'

export type {
  SaveManifest,
  TurnSnapshot,
  EventLogEntry,
  PendingOrdersByFaction,
  DiagnosticLogLevel,
  DiagnosticLogEntry,
} from './game-storage'

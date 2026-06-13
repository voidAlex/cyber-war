/**
 * 物理规则桩（physics-rules.ts）— 纯函数（铁律边界）。
 *
 * 纯数值规则：移动消耗、地形防御加成、燃料/弹药/疲劳等。
 * 物理引擎跑在 Web Worker（src/workers/physics.worker.ts），主线程不卡 UI。
 * 确定性种子 = scenarioSeed:turn:seq，可重算可复现。
 *
 * 里程碑：M2（物理 Worker + physics-rules）。
 *
 * @module layers/domain/physics-rules
 */

/**
 * 物理规则桩。
 * TODO(M2): 由后续子代理实现完整数值公式（移动/防御/消耗）。
 */
export function applyPhysicsRules(): void {
  // TODO(M2): 纯数值规则计算
}

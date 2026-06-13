/**
 * 外交结算桩（diplomacy.ts）— 纯函数（铁律边界）。
 *
 * 信任度 0..100（盟友 60/中立 50/敌对 5 起步），履约 +5~10、毁约 -15~25；
 * <30 盟友请求拒绝率陡升，<15 可能倒戈。
 *
 * 里程碑：M4（外交信任度）。
 *
 * @module layers/domain/diplomacy
 */

/**
 * 信任度变动计算（草案）。
 * TODO(M4): 由后续子代理实现信任度规则与倒戈概率。
 */
export function applyTrustChange(current: number, delta: number): number {
  // TODO(M4): 含 <30/<15 阈值行为
  return Math.max(0, Math.min(100, current + delta))
}

/**
 * 情报结算桩（intelligence.ts）— 纯函数（铁律边界）。
 *
 * 情报四级（L0 盲区 / L1 热力脉冲 / L2 编制确认 / L3 全量透视）+
 * 半衰期残影（halfLifeTurns=3，超半衰降级显示残影 + [T-Nh]）。
 *
 * 里程碑：M4（情报 4 级 + 半衰残影）。
 *
 * @module layers/domain/intelligence
 */

import type { IntelLevel } from '@/types'

/**
 * 情报衰减计算（草案）。
 * TODO(M4): 由后续子代理实现半衰残影与显示截断。
 */
export function decayIntel(_level: IntelLevel, _staleTurns: number): IntelLevel {
  // TODO(M4): 按半衰规则降级
  return _level
}

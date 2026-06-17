/**
 * 天气持续系统（domain/weather.ts）— 纯函数天气演化。
 *
 * 重写计划第 1 批 T1-B：每回合 rollWeather 决定天气演化。
 * - remainingTurns > 0：延续当前天气，remainingTurns -1（天气持续中）。
 * - remainingTurns = 0（或首回合无 currentWeather）：按 rng 随机新天气，
 *   持续 [baseDuration, baseDuration+2] 回合（缺省 baseDuration=2 → [2,4]）。
 * - 新天气类型从 rules.possibleTypes 池中随机选取（缺省全部 5 类）。
 *
 * 天气 modifier 与 type 绑定（WEATHER_MODIFIER_MAP），物理引擎读 modifiers：
 * - movementCostMult：乘 movementCost（rain 1.5 / storm 2 / snow 2.5）。
 * - visibilityPenalty：负值，|penalty| 用于 intel level 降级（fog -2 / storm -1 / snow -1）。
 * - combatMod：火力倍率（storm -0.1 / snow -0.15）。
 *
 * 全纯函数，随机数由调用方注入 DeterministicRandom（铁律）。相同输入 → 相同输出。
 *
 * @module layers/domain/weather
 */

import type { WeatherType, WeatherState, WeatherModifiers } from '@/types'
import type { CampaignWeatherRules } from '@/types'
import type { DeterministicRandom } from './deterministic-random'

/**
 * 天气类型 → modifier 映射表（T1-B 数值假设）。
 *
 * 与 WeatherState.modifiers 绑定——rollWeather 产出新天气时直接查表填 modifiers，
 * 避免各处重复映射导致漂移。
 */
export const WEATHER_MODIFIER_MAP: Record<WeatherType, WeatherModifiers> = {
  // 晴天：无任何 modifier（基准 1/0/0）
  clear: { movementCostMult: 1, visibilityPenalty: 0, combatMod: 0 },
  // 雨：泥泞，机动消耗 ×1.5
  rain: { movementCostMult: 1.5, visibilityPenalty: 0, combatMod: 0 },
  // 暴风雨：机动 ×2，能见度 -1 level，火力 -0.1
  storm: { movementCostMult: 2, visibilityPenalty: -1, combatMod: -0.1 },
  // 雾：能见度 -2 level（侦察范围骤降），机动无影响
  fog: { movementCostMult: 1, visibilityPenalty: -2, combatMod: 0 },
  // 雪：机动 ×2.5，能见度 -1 level，火力 -0.15
  snow: { movementCostMult: 2.5, visibilityPenalty: -1, combatMod: -0.15 },
}

/** 默认天气类型池（rules 未指定 possibleTypes 时用全部 5 类）。 */
const DEFAULT_POSSIBLE_TYPES: readonly WeatherType[] = [
  'clear',
  'rain',
  'storm',
  'fog',
  'snow',
]

/** 默认基准持续回合（rules 未指定 baseDuration 时用 2 → 实际 [2,4]）。 */
const DEFAULT_BASE_DURATION = 2

/**
 * rollWeather 输入（campaign rules 可选约束）。
 *
 * 与 CampaignWeatherRules 同构（possibleTypes/baseDuration），但 rollWeather
 * 直接消费此结构（rules.weather 传入即可）。
 */
export type WeatherRules = CampaignWeatherRules

/**
 * 推进天气演化（纯函数，确定性）。
 *
 * 逻辑：
 * 1. currentWeather.remainingTurns > 0 → 延续当前 type，remainingTurns -1。
 *    modifiers 保持与 type 绑定（不变）。
 * 2. currentWeather.remainingTurns = 0 或 currentWeather=undefined（首回合）→
 *    按 rng 随机新 type（从 rules.possibleTypes 池），持续 [baseDuration, baseDuration+2]。
 *    modifiers 查 WEATHER_MODIFIER_MAP 填充。
 *
 * @param currentWeather 当前回合天气状态（undefined=首回合/无天气）
 * @param _turn 当前回合索引（保留参数，便于未来按回合调整天气概率）
 * @param rng 注入的确定性随机
 * @param rules 战役天气规则（possibleTypes/baseDuration，可选）
 * @returns 新回合的天气状态
 */
export function rollWeather(
  currentWeather: WeatherState | undefined,
  _turn: number,
  rng: DeterministicRandom,
  rules?: WeatherRules,
): WeatherState {
  // 1. 当前天气仍持续 → 延续（remainingTurns -1，最低 0）
  if (currentWeather && currentWeather.remainingTurns > 0) {
    return {
      type: currentWeather.type,
      remainingTurns: currentWeather.remainingTurns - 1,
      modifiers: WEATHER_MODIFIER_MAP[currentWeather.type],
    }
  }

  // 2. 切换新天气（remainingTurns=0 或首回合无天气）
  const possibleTypes =
    rules?.possibleTypes && rules.possibleTypes.length > 0
      ? rules.possibleTypes
      : DEFAULT_POSSIBLE_TYPES
  const baseDuration = rules?.baseDuration ?? DEFAULT_BASE_DURATION

  // 随机选 type（DeterministicRandom.pick 按权重/等概率）
  const newType = rng.pick(possibleTypes as readonly WeatherType[])
  // 持续时间 [baseDuration, baseDuration+2]（rng.nextInt 闭区间）
  const duration = rng.nextInt(baseDuration, baseDuration + 2)

  return {
    type: newType,
    remainingTurns: duration,
    modifiers: WEATHER_MODIFIER_MAP[newType],
  }
}

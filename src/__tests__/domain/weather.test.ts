/**
 * 天气持续系统（domain/weather.ts）单测。
 *
 * 验证 rollWeather 纯函数的确定性 + 天气类型映射 + 剩余回合延续逻辑。
 *
 * @module __tests__/domain/weather
 */

import { describe, expect, it } from 'vitest'
import { DeterministicRandom } from '@/layers/domain/deterministic-random'
import { rollWeather, WEATHER_MODIFIER_MAP } from '@/layers/domain/weather'
import type { WeatherState } from '@/types'

describe('rollWeather', () => {
  it('remainingTurns>0 → 延续当前 type，remainingTurns -1', () => {
    const current: WeatherState = {
      type: 'rain',
      remainingTurns: 3,
      modifiers: WEATHER_MODIFIER_MAP.rain,
    }
    const rng = new DeterministicRandom('w-continue')
    const next = rollWeather(current, 5, rng)
    expect(next.type).toBe('rain')
    expect(next.remainingTurns).toBe(2)
    // modifiers 与 type 绑定（rain={movementCostMult:1.5}）
    expect(next.modifiers.movementCostMult).toBe(1.5)
  })

  it('remainingTurns=1 → 本回合仍延续，下回合变 0（=1-1）', () => {
    const current: WeatherState = {
      type: 'fog',
      remainingTurns: 1,
      modifiers: WEATHER_MODIFIER_MAP.fog,
    }
    const rng = new DeterministicRandom('w-last-turn')
    const next = rollWeather(current, 5, rng)
    expect(next.type).toBe('fog')
    expect(next.remainingTurns).toBe(0)
  })

  it('remainingTurns=0 → 随机新天气，持续 2-4 回合', () => {
    // current.remainingTurns=0 触发 rollWeather 切换
    const current: WeatherState = {
      type: 'clear',
      remainingTurns: 0,
      modifiers: WEATHER_MODIFIER_MAP.clear,
    }
    const rng = new DeterministicRandom('w-change-seed-A')
    const next = rollWeather(current, 5, rng)
    // 新天气的 remainingTurns 必须在 [2,4]
    expect(next.remainingTurns).toBeGreaterThanOrEqual(2)
    expect(next.remainingTurns).toBeLessThanOrEqual(4)
    // modifiers 与新 type 绑定（用 WEATHER_MODIFIER_MAP 校验）
    expect(next.modifiers).toEqual(WEATHER_MODIFIER_MAP[next.type])
  })

  it('无 currentWeather（首回合）→ 产出 clear 或随机天气', () => {
    const rng = new DeterministicRandom('w-first-turn')
    const next = rollWeather(undefined, 0, rng)
    // 首回合无当前天气 → rollWeather 视为 remainingTurns=0 触发新天气
    expect(next.type).toBeDefined()
    expect(next.remainingTurns).toBeGreaterThanOrEqual(2)
    expect(next.remainingTurns).toBeLessThanOrEqual(4)
  })

  it('确定性：相同输入两次 rollWeather → 完全相同', () => {
    const current: WeatherState = {
      type: 'clear',
      remainingTurns: 0,
      modifiers: WEATHER_MODIFIER_MAP.clear,
    }
    const r1 = rollWeather(current, 5, new DeterministicRandom('w-det'))
    const r2 = rollWeather(current, 5, new DeterministicRandom('w-det'))
    expect(r1).toEqual(r2)
  })

  it('rules.possibleTypes 约束：仅从 possibleTypes 中选取新天气', () => {
    const current: WeatherState = {
      type: 'clear',
      remainingTurns: 0,
      modifiers: WEATHER_MODIFIER_MAP.clear,
    }
    const rules = { possibleTypes: ['clear', 'rain', 'storm'] as const, baseDuration: 3 }
    // 多次采样，确保结果都在 possibleTypes 内（确定性 rng 但多次种子验证约束）
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const next = rollWeather(current, 5, new DeterministicRandom(seed), rules)
      expect(rules.possibleTypes).toContain(next.type)
    }
  })

  it('rules.baseDuration 覆盖默认持续时间', () => {
    const current: WeatherState = {
      type: 'clear',
      remainingTurns: 0,
      modifiers: WEATHER_MODIFIER_MAP.clear,
    }
    const rules = { possibleTypes: ['rain'] as const, baseDuration: 4 }
    const next = rollWeather(current, 5, new DeterministicRandom('w-base-dur'), rules)
    // baseDuration=4 → remainingTurns 在 [baseDuration, baseDuration+2]=[4,6]？按计划是 2-4 默认
    // baseDuration 作为基准，实际范围 [baseDuration, baseDuration+2]（与默认 baseDuration=2 → [2,4] 一致）
    expect(next.remainingTurns).toBeGreaterThanOrEqual(rules.baseDuration)
    expect(next.remainingTurns).toBeLessThanOrEqual(rules.baseDuration + 2)
  })
})

describe('WEATHER_MODIFIER_MAP', () => {
  it('clear = 无 modifier（全部为 undefined/0）', () => {
    expect(WEATHER_MODIFIER_MAP.clear.movementCostMult).toBe(1)
    expect(WEATHER_MODIFIER_MAP.clear.visibilityPenalty).toBe(0)
    expect(WEATHER_MODIFIER_MAP.clear.combatMod).toBe(0)
  })

  it('rain = movementCostMult 1.5', () => {
    expect(WEATHER_MODIFIER_MAP.rain.movementCostMult).toBe(1.5)
  })

  it('storm = movementCostMult 2, visibilityPenalty -1, combatMod -0.1', () => {
    expect(WEATHER_MODIFIER_MAP.storm.movementCostMult).toBe(2)
    expect(WEATHER_MODIFIER_MAP.storm.visibilityPenalty).toBe(-1)
    expect(WEATHER_MODIFIER_MAP.storm.combatMod).toBe(-0.1)
  })

  it('fog = visibilityPenalty -2', () => {
    expect(WEATHER_MODIFIER_MAP.fog.visibilityPenalty).toBe(-2)
  })

  it('snow = movementCostMult 2.5, visibilityPenalty -1, combatMod -0.15', () => {
    expect(WEATHER_MODIFIER_MAP.snow.movementCostMult).toBe(2.5)
    expect(WEATHER_MODIFIER_MAP.snow.visibilityPenalty).toBe(-1)
    expect(WEATHER_MODIFIER_MAP.snow.combatMod).toBe(-0.15)
  })
})

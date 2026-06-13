/**
 * 确定性随机数封装（DeterministicRandom）— 领域层纯函数基石。
 *
 * 借鉴 src-legacy 的 seedrandom 封装思路，但放在 domain 层、重写实现。
 *
 * 核心契约（重写计划「确定性两层」「防坑-确定性 sequence」、TDD §3.1）：
 * - **确定性种子 = `scenarioSeed + ':' + turn + ':' + sequence`**。
 * - 相同种子 → 相同随机序列（可重算、可复现，CI 比对 event-log 哈希）。
 * - 随机数与调度/完成顺序无关：每个 ActionEnvelope 拥有预分配的 sequence
 *   （参谋 0+ / 战区 1000+ / 敌盟 2000+ / 导演 3000+），由调用方注入对应 RNG，
 *   即便多 Agent 真并行执行，每个 Agent 拿到的种子仍稳定。
 *
 * 铁律：
 * - 本文件禁止调 `Math.random()` / `Date.now()` / 任何外部 IO。
 * - 领域结算函数必须接收一个 DeterministicRandom 实例（依赖注入），
 *   而非自己 new——保证 vitest 可注入固定种子、保证回放可复现。
 *
 * @module layers/domain/deterministic-random
 */

import seedrandom from 'seedrandom'

/**
 * 由三个确定性维度（场景种子 / 回合 / 预分配序号）构造确定性种子串。
 *
 * 用 `:` 分隔，避免歧义。例：`verdun-1916:12:1003`。
 *
 * @param scenarioSeed 场景固定种子（WorldState.scenarioSeed）
 * @param turn 回合索引（WorldState.turnIndex）
 * @param sequence 预分配序号（ActionEnvelope.sequence）
 */
export function buildSeed(scenarioSeed: string, turn: number, sequence: number): string {
  return `${scenarioSeed}:${turn}:${sequence}`
}

/**
 * 确定性伪随机数生成器。
 *
 * 封装 seedrandom，提供面向兵棋结算的高层 API。
 * 实例不可变：构造后内部 generator 状态在 next() 调用中推进，
 * 但相同构造参数永远产生相同序列。
 */
export class DeterministicRandom {
  /** seedrandom PRNG 实例（私有，禁止外部直接触碰破坏确定性） */
  private readonly generator: seedrandom.PRNG

  /** 本实例的确定性种子串（便于 diagnostics/留痕，绝不写敏感信息） */
  readonly seed: string

  /**
   * @param seed 确定性种子串（推荐用 buildSeed 生成）
   */
  constructor(seed: string) {
    this.seed = seed
    this.generator = seedrandom(seed)
  }

  /**
   * 便捷构造：直接由三维度构造实例。
   */
  static fromSequence(scenarioSeed: string, turn: number, sequence: number): DeterministicRandom {
    return new DeterministicRandom(buildSeed(scenarioSeed, turn, sequence))
  }

  /**
   * 下一个 [0, 1) 浮点数（底层 seedrandom.double）。
   * 用 double() 而非 quick() 以获得完整 32 位精度。
   */
  nextFloat(): number {
    return this.generator.double()
  }

  /**
   * 下一个 [min, max] 闭区间整数。
   *
   * 使用 floor(uniform * range) 保证下闭上闭、均匀分布。
   */
  nextInt(min: number, max: number): number {
    // 防呆：保证 lo <= hi，避免负范围产生反直觉结果
    const lo = Math.min(min, max)
    const hi = Math.max(min, max)
    const range = hi - lo + 1
    return Math.floor(this.nextFloat() * range) + lo
  }

  /**
   * 概率判定：返回 true 的概率为 `probability`（0..1）。
   *
   * probability <= 0 恒 false，>= 1 恒 true。
   */
  chance(probability: number): boolean {
    if (probability <= 0) return false
    if (probability >= 1) return true
    return this.nextFloat() < probability
  }

  /**
   * 按权重从数组中随机挑选一个元素（确定性）。
   *
   * @param items 候选数组（非空）
   * @param weights 对应权重（正数，可不传——等概率）
   * @returns 选中的元素
   */
  pick<T>(items: readonly T[], weights?: readonly number[]): T {
    if (items.length === 0) {
      throw new Error('DeterministicRandom.pick: items 不能为空')
    }
    if (items.length === 1) return items[0]

    if (!weights) {
      // 等概率
      return items[this.nextInt(0, items.length - 1)]
    }
    if (weights.length !== items.length) {
      throw new Error('DeterministicRandom.pick: weights 长度须与 items 一致')
    }
    const total = weights.reduce((s, w) => s + Math.max(0, w), 0)
    if (total <= 0) {
      // 全零权重兜底：退化为等概率
      return items[this.nextInt(0, items.length - 1)]
    }
    let r = this.nextFloat() * total
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i])
      if (r < 0) return items[i]
    }
    // 浮点兜底：返回最后一个
    return items[items.length - 1]
  }
}

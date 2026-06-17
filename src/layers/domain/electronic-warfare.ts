/**
 * 电子战（electronic-warfare.ts）— 纯函数。
 *
 * T2 第 2 批：EW 单位的被动效果（干扰敌方 intel / 增强己方侦察 / 降低隐身单位可探测性）。
 *
 * 设计（重写计划「第 2 批 EW」）：
 * - applyEWEffects(world)：每方 EW 单位对**射程内**（jammingRange，曼哈顿距离）的敌方单位
 *   施加 intel level 降级（干扰），对己方侦察单位 +detectionBoost level（增强）。
 * - 同时 EW 单位本身的 stealthReduction 在敌方对其侦察时降低成功率（由 resolveReconOrder
 *   消费，见 physics.worker）。
 *
 * 全纯函数，不可变产出：返回 intelDegraded/intelBoosted Map，调用方（physics.worker）
 * 落地到 stateChanges.unitUpdates[enemyId].detection / 己方 recon unit.detection。
 *
 * 确定性：纯数值/几何计算，无随机数（成功率判定在 worker recon 流程用注入 rng）。
 *
 * @module layers/domain/electronic-warfare
 */

import type { WorldState, IntelLevel, IntelObservation } from '@/types'

/**
 * applyEWEffects 返回结构（不可变，由调用方落地）。
 *
 * - intelDegraded：被干扰的敌方单位 → 该方对其观测的 level 降级（key=unitId，
 *   value=新 IntelObservation，含降级后 level + 标记 jammedTurn=当前回合）。
 * - intelBoosted：受己方 EW 增强的侦察单位 → 该单位对各观测方的 detection 提升
 *   （key=reconUnitId，value=observerFactionId → 新 IntelObservation，注意此处
 *   IntelObservation 属「被观测单位」视角，本字段语义为「己方 EW 增强了己方对敌方的观测」，
 *   故实际落地由 worker 转换：EW 单位 → 对其 detectionBoost 范围内的己方 recon unit
 *   视野内敌方单位 detection level +N）。
 *
 * 为简化落地，本函数返回的 intelBoosted 直接给出「被升级的敌方单位 detection 增量」
 * （key=enemyUnitId，value=observerFactionId → 新 IntelObservation），
 * 与 intelDegraded 同构（observerFactionId 即施加 EW 的己方阵营）。
 * 这样 worker 把两份增量合并写 stateChanges.unitUpdates[*].detection 即可。
 */
export interface EWEffectsResult {
  /**
   * 被干扰的敌方单位 detection 增量：key=unitId，value=observerFactionId → 新 IntelObservation。
   * observerFactionId = 施加干扰的 EW 单位所属阵营（对其敌方的观测降级）。
   */
  intelDegraded: Map<string, Record<string, IntelObservation>>
  /**
   * 被增强观测的敌方单位 detection 增量：key=unitId，value=observerFactionId → 新 IntelObservation。
   * observerFactionId = 施加 EW 支援的阵营（对其敌方的观测升级 +detectionBoost）。
   */
  intelBoosted: Map<string, Record<string, IntelObservation>>
}

/** 干扰降级幅度（jammingRange 内的敌方单位 intel level 降级量）。 */
const EW_JAM_DEGRADE_LEVEL = 1

/**
 * 计算所有 EW 单位的被动效果（每回合 simulateTurn 开头调用一次）。
 *
 * 算法：
 * 1. 遍历所有带 ewCapability 的单位（含 ew 类型与挂载 EW 吊舱的隐身战机等）。
 * 2. 对每个 EW 单位：
 *    a. 干扰（jammingRange）：曼哈顿距离 ≤ jammingRange 的**敌方**单位，对其
 *       `detection[EWFaction]` 观测 level 降级（最多降到 L0，不降到 L0 以下也不升）。
 *       注：仅当 EW 阵营对该敌方单位**已有观测**（level≥L1）时才降级——盲区 L0 无可降级。
 *    b. 增强（detectionBoost）：曼哈顿距离 ≤ jammingRange 的**敌方**单位，
 *       EW 阵营对其观测 level +detectionBoost（封顶 L3）。此项模拟「EW 平台增强己方传感器」，
 *       把 EW 单位当作移动侦察哨。
 *    （同一敌方单位若同时被多个 EW 单位作用，取降级/升级的累加结果——
 *     本函数按 EW 单位顺序逐次更新 detection，最终态写入 Map。）
 *
 * 不修改输入 world（不可变产出）。返回的 Map 由调用方合并到 stateChanges。
 *
 * @param world 当前世界状态（只读）
 * @param turn 当前结算回合（写入 lastSeenTurn/staleTurns 语义）
 * @returns intelDegraded + intelBoosted detection 增量 Map
 */
export function applyEWEffects(
  world: WorldState,
  turn: number,
): EWEffectsResult {
  const intelDegraded = new Map<string, Record<string, IntelObservation>>()
  const intelBoosted = new Map<string, Record<string, IntelObservation>>()

  for (const ewUnit of world.units) {
    const ew = ewUnit.ewCapability
    if (!ew) continue
    if (ewUnit.strength <= 0) continue // 已歼灭/无效单位不施加 EW

    const ewFaction = ewUnit.factionId

    // 干扰范围 = jammingRange（缺省 0 表示无干扰），增强范围 = max(jammingRange, detectionBoost>0?1:0)
    // 简化：干扰与增强共用 jammingRange 半径（detectionBoost 数值控制增强幅度）。
    const range = ew.jammingRange
    if (range <= 0 && ew.detectionBoost <= 0) continue

    for (const target of world.units) {
      if (target.factionId === ewFaction) continue // 仅作用于敌方单位
      if (target.strength <= 0) continue
      const dist =
        Math.abs(target.coord.col - ewUnit.coord.col) +
        Math.abs(target.coord.row - ewUnit.coord.row)
      if (dist > range) continue

      // EW 阵营对该敌方单位的当前观测
      const curObs: IntelObservation =
        target.detection[ewFaction] ?? {
          observerFactionId: ewFaction,
          level: 0 as IntelLevel,
          lastSeenTurn: -1,
          staleTurns: 0,
        }

      // 累积当前 Map 中已写入的增量（多 EW 单位叠加）
      const degradedExisting =
        intelDegraded.get(target.id)?.[ewFaction] ?? curObs
      const boostedExisting =
        intelBoosted.get(target.id)?.[ewFaction] ?? degradedExisting

      // 干扰：level -EW_JAM_DEGRADE_LEVEL（下限 L0，不升）
      const degradedLevel = Math.max(
        0,
        (degradedExisting.level as number) - EW_JAM_DEGRADE_LEVEL,
      ) as IntelLevel
      const degradedObs: IntelObservation = {
        ...degradedExisting,
        observerFactionId: ewFaction,
        level: degradedLevel,
        // 干扰不刷新 lastSeenTurn（仍按旧观测时间衰减残影），仅 level 降级
      }
      mergeIntoMap(intelDegraded, target.id, ewFaction, degradedObs)

      // 增强：level +detectionBoost（上限 L3，不降）。
      // 仅当 detectionBoost > 0 时施加（避免无增强能力的 EW 单位误升 level）。
      if (ew.detectionBoost > 0) {
        const baseLevel = boostedExisting.level as number
        const boostedLevel = Math.min(
          3,
          baseLevel + ew.detectionBoost,
        ) as IntelLevel
        const boostedObs: IntelObservation = {
          ...boostedExisting,
          observerFactionId: ewFaction,
          level: boostedLevel,
          // 增强刷新 lastSeenTurn（视为本回合新侦察命中，残影清零）
          lastSeenTurn: turn,
          staleTurns: 0,
        }
        mergeIntoMap(intelBoosted, target.id, ewFaction, boostedObs)
      }
    }
  }

  return { intelDegraded, intelBoosted }
}

/**
 * 把单条 detection 增量合并进 Map（key=unitId，value=observerFactionId → IntelObservation）。
 *
 * 同一 (unitId, observerFactionId) 组合被多 EW 单位写入时，新值覆盖旧值
 * （applyEWEffects 已按 EW 单位顺序累积计算，最后一次写入为最终态）。
 */
function mergeIntoMap(
  map: Map<string, Record<string, IntelObservation>>,
  unitId: string,
  observerFactionId: string,
  obs: IntelObservation,
): void {
  const existing = map.get(unitId) ?? {}
  existing[observerFactionId] = obs
  map.set(unitId, existing)
}

/**
 * EW 命令结算产出的 detection 增量结构（resolveEWOrder 用）。
 *
 * 与 applyEWEffects 返回结构同构（unitId → observerFactionId → IntelObservation），
 * 由 physics.worker 合并到 stateChanges.unitUpdates[enemyId].detection。
 */
export type EWDetectionDelta = Record<string, Record<string, IntelObservation>>

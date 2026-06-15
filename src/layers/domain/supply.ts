/**
 * 补给线/后勤（supply.ts）— 纯函数（第 4 批，改动最大批次）。
 *
 * 战役机制补齐：把"补给"从点状 fuel/ammo 固定扣升级为**网络化**：
 * 地图声明 SupplyNetwork.lines（cellIds 有序路径，source→前线），单位向 source
 * 做连通性判定；路径上任意 cell 被敌方占据即视为**补给被切断**（severed）。
 *
 * === 纯函数边界（铁律）===
 *
 * 本文件全纯函数：无随机、无 IO、无 Date.now。输入完全决定输出，
 * 可直接 vitest 单测、CI 回放哈希比对、二次回放一致。
 *
 * === 不伪造（铁律）===
 *
 * 补给网络**仅消费** map.supplyNetwork 定义的路径，绝不编造未声明的路线。
 * 若 map.supplyNetwork 为 undefined 或某阵营无线 → 所有单位恒为 connected=true
 * （向后兼容：存量地图/测试不受影响，仍走"点状补给"语义）。
 *
 * === 确定性 ===
 *
 * BFS 沿固定结构的 SupplyLine 走，遍历顺序由 cellIds 序列决定（无随机扰动），
 * 同 (map, units, factionId) → 同输出。
 *
 * @module layers/domain/supply
 */

import type {
  Unit,
  UnitStatusFlag,
  GameMap,
} from '@/types'
import type { CampaignSupplyRules } from '@/types'

/**
 * 切断补给时基线消耗倍率（默认）。
 *
 * 见 physics-rules.computeBaselineConsumption 的 supplyMultiplier 参数：
 * 连通=1.0，切断=SEVERED_SUPPLY_MULTIPLIER（=2.0，可被 rules.supply.severedMultiplier 覆写）。
 */
export const SEVERED_SUPPLY_MULTIPLIER = 2.0

/**
 * 切断补给时士气固定下降（applySupplyState 中应用，纯数值不引入随机）。
 */
export const SEVERED_MORALE_PENALTY = 5

/**
 * 单单位补给连通性结果。
 */
export interface SupplyConnectivity {
  /** 是否连通到补给源（true=补给充足路径畅通） */
  connected: boolean
  /** 命中的补给源 cellId 列表（connected=true 时至少含一个；false 时为空） */
  sources: string[]
  /** 被阻断的 cellId（connected=false 时填，便于 UI/AI 高亮"瓶颈"格） */
  blockedAt?: string
}

/**
 * 计算某阵营所有单位的补给连通性（BFS 沿 supplyNetwork.lines，纯函数）。
 *
 * 算法（确定性）：
 * 1. 取 map.supplyNetwork.lines 中 factionId 匹配的线（仅本阵营线补给本阵营单位）。
 * 2. 对每条线，预先标注：
 *    - source = cellIds[0]（应与 cell.isSupplySource=true 对应）。
 *    - 路径上每个 cell 是否被**敌方**单位占据（occupantFactionId !== factionId）。
 *      （己方单位占路径格视为正常护送，不阻断。）
 * 3. 对每个 factionId 单位：
 *    - 若单位正好位于某条线的某 cellId（k），从 k 向 source（k→0）回溯，
 *      途中遇到第一个被敌方占据的 cell 即 blockedAt；否则连通（sources 收集所有可达的 source）。
 *    - 单位不位于任何线 → connected=false（被孤立，无补给路线）。
 *      （凡尔登的法军前沿若不在"神圣之路"路径格上，仍视为有补给——
 *       需在数据中把单位部署格纳入 cellIds。设计意图：cellIds 列表应覆盖
 *       该阵营所有需要补给的格。）
 *
 * 简化语义：单位需**自身位于 supplyNetwork 某条线的 cellIds 之内**才视为"在线上"。
 * 这避免引入路径搜索（地图邻接），保持纯函数与确定性，且符合"补给沿公路/铁路
 * 走"的直观。不在线上的单位仍允许 connected=false（孤立无补给），
 * 此为有意设计，调用方（worker）可据此加 low_supply 标记。
 *
 * 不伪造：路径仅来自 map.supplyNetwork，绝不构造未声明路线。
 * 缺省兼容：map.supplyNetwork===undefined → 所有单位 connected=true。
 *
 * @param map 地图（含 supplyNetwork）
 * @param units 全部单位（用于判定 cell 占据方）
 * @param factionId 待判定的阵营
 * @returns unitId → SupplyConnectivity（含歼灭单位 strength<=0 跳过）
 */
export function computeSupplyConnectivity(
  map: GameMap,
  units: readonly Unit[],
  factionId: string,
): Map<string, SupplyConnectivity> {
  const result = new Map<string, SupplyConnectivity>()

  // 缺省兼容：无补给网络 → factionId 匹配的（活着的）单位恒为连通
  if (!map.supplyNetwork || map.supplyNetwork.lines.length === 0) {
    for (const unit of units) {
      if (unit.strength <= 0) continue
      if (unit.factionId !== factionId) continue
      result.set(unit.id, { connected: true, sources: [] })
    }
    return result
  }

  // 预构建 cellId → 占据方阵营 id（取首个非歼灭占据单位）
  const cellOccupant = new Map<string, string>()
  for (const unit of units) {
    if (unit.strength <= 0) continue
    const cellId = `${unit.coord.col}:${unit.coord.row}`
    // 同一格多单位：取首个（首次写入优先，确定性）
    if (!cellOccupant.has(cellId)) {
      cellOccupant.set(cellId, unit.factionId)
    }
  }

  // 取本阵营的补给线
  const ownLines = map.supplyNetwork.lines.filter((l) => l.factionId === factionId)

  // 本阵营无任何补给线 → 视为缺省连通（兼容：该阵营未声明补给网络，
  // 不应被误判为"全员被切断"；与 map.supplyNetwork===undefined 同语义）。
  if (ownLines.length === 0) {
    for (const unit of units) {
      if (unit.strength <= 0) continue
      if (unit.factionId !== factionId) continue
      result.set(unit.id, { connected: true, sources: [] })
    }
    return result
  }

  // 单位 → 所在 cellId
  const unitCellId = (unit: Unit): string => `${unit.coord.col}:${unit.coord.row}`

  for (const unit of units) {
    if (unit.strength <= 0) continue
    if (unit.factionId !== factionId) continue

    // 单位需位于至少一条本阵营线的 cellIds 内，才视为"在线上"
    let connected = false
    const sources: string[] = []
    let blockedAt: string | undefined

    for (const line of ownLines) {
      // 单位在该线的位置 k（cellId 匹配）。同一线内同 cellId 多次出现的取首次。
      const unitCell = unitCellId(unit)
      let k = -1
      for (let i = 0; i < line.cellIds.length; i++) {
        // cellIds 用 map.cell.id 风格（如 "cell-7-2"）；单位坐标是 "col:row"
        if (line.cellIds[i] === unitCell || normalizeCellId(line.cellIds[i]) === unitCell) {
          k = i
          break
        }
      }
      if (k < 0) continue // 单位不在此线

      // 从 k 向 source（index 0）回溯
      const source = line.cellIds[0]
      let pathBlocked = false
      for (let i = k; i >= 0; i--) {
        const cellOnPath = normalizeCellId(line.cellIds[i])
        const occupant = cellOccupant.get(cellOnPath)
        if (occupant !== undefined && occupant !== factionId) {
          // 敌方占据路径上该格 → 阻断
          pathBlocked = true
          if (blockedAt === undefined) blockedAt = line.cellIds[i]
          break
        }
      }
      if (!pathBlocked) {
        connected = true
        if (!sources.includes(source)) sources.push(source)
        // 仍继续扫其他线（可能多个 source 都可达）
      }
      // 若此线阻断，继续看其他线是否连通（多源冗余）
    }

    // 若单位不位于任何线，但本阵营有 supplySource cell 且单位就在该格 → 视为连通（自给）
    if (!connected && sources.length === 0) {
      const unitCell = unitCellId(unit)
      const onSourceCell = map.cells.some(
        (c) => c.isSupplySource && `${c.col}:${c.row}` === unitCell,
      )
      if (onSourceCell) {
        connected = true
        sources.push(unitCell)
      }
    }

    result.set(unit.id, { connected, sources, blockedAt })
  }

  return result
}

/**
 * 把 supplyMultiplier 解析为实际倍率（rules.severedMultiplier 覆写默认）。
 *
 * 纯函数：无随机；缺省取 SEVERED_SUPPLY_MULTIPLIER。
 *
 * @param rules 战役补给规则（可选）
 * @param connected 是否连通
 * @returns 倍率（连通=1.0，切断= severedMultiplier ?? SEVERED_SUPPLY_MULTIPLIER）
 */
export function resolveSupplyMultiplier(
  connected: boolean,
  rules?: CampaignSupplyRules,
): number {
  if (connected) return 1.0
  return rules?.severedMultiplier ?? SEVERED_SUPPLY_MULTIPLIER
}

/**
 * 根据补给连通性产出单位的增量变更（不可变）。
 *
 * 切断（connected=false）时：
 * - 加 'low_supply' 状态标记（若未已有）。
 * - 士气 -SEVERED_MORALE_PENALTY（封底 0）。
 *
 * 注：fuel/ammo 的"加速消耗"由 computeBaselineConsumption 的 supplyMultiplier
 *   在 worker applyBaselineToAll 中体现（×2 基线扣）；本函数只负责状态标记与士气，
 *   不直接动 fuel/ammo 数值（避免与基线消耗重复扣）。
 *
 * 连通（connected=true）时：若单位曾带 low_supply 标记，恢复时由 worker 推
 * 'supply_restored' 事件移除该标记（见 physics.worker）。本纯函数在 connected=true
 * 时**不主动**清除 low_supply——清除与否取决于 fuel/ammo 是否回到阈值
 * （physics-rules.isLowSupply 判定）。保持单一真相源。
 *
 * @param unit 单位（只读）
 * @param connected 供应链连通性
 * @returns Partial<Unit>（status / morale 增量；无变更则空对象）
 */
export function applySupplyState(
  unit: Unit,
  connected: boolean,
): Partial<Unit> {
  if (connected) return {} // 连通时不主动改（恢复由基线数值判定驱动）

  // 切断：加 low_supply + 士气 -5
  const hasLowSupply = unit.status.includes('low_supply')
  const newStatus: UnitStatusFlag[] = hasLowSupply
    ? unit.status
    : [...unit.status, 'low_supply' as UnitStatusFlag]
  const newMorale = Math.max(0, unit.morale - SEVERED_MORALE_PENALTY)
  return {
    status: newStatus,
    morale: newMorale,
  }
}

/**
 * 找出"占领即可切断敌方补给"的 cellId（供 AI 与玩家"切断补给"命令参考）。
 *
 * 算法（确定性，纯函数）：
 * 1. 取 map.supplyNetwork.lines 中 factionId **非** factionId 的线（即敌方线）。
 * 2. 对每条敌方线，遍历 cellIds（排除 source，因占领 source 通常意味战局已定），
 *    收集"当前未被敌方占据"的格（即我方可占领、占领后能阻断此线的格）。
 * 3. 去重返回 cellId 列表（normalizeCellId 归一为 "col:row"，便于调用方按坐标下达命令）。
 *
 * 不伪造：仅返回 map.supplyNetwork 声明的路径上的 cell。无网络时返回空数组。
 *
 * @param map 地图
 * @param units 全部单位
 * @param factionId 我方阵营（要切断其敌方的补给）
 * @returns 可切断敌方补给的 cellId（"col:row" 形式）列表，按出现顺序去重
 */
export function findSupplyCutOpportunities(
  map: GameMap,
  units: readonly Unit[],
  factionId: string,
): string[] {
  if (!map.supplyNetwork || map.supplyNetwork.lines.length === 0) {
    return []
  }

  // cellId → 占据方（活单位）
  const cellOccupant = new Map<string, string>()
  for (const unit of units) {
    if (unit.strength <= 0) continue
    const cellId = `${unit.coord.col}:${unit.coord.row}`
    if (!cellOccupant.has(cellId)) cellOccupant.set(cellId, unit.factionId)
  }

  const enemyLines = map.supplyNetwork.lines.filter((l) => l.factionId !== factionId)
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of enemyLines) {
    // 跳过 source（cellIds[0]）：占领敌方补给源通常等同于歼灭其主力，
    // 不在"切断补给线"战术目标范围内。
    for (let i = 1; i < line.cellIds.length; i++) {
      const cellId = normalizeCellId(line.cellIds[i])
      if (seen.has(cellId)) continue
      // 仅当该格当前**未被敌方占据**（我方可占领、或为空）才有切断价值
      const occupant = cellOccupant.get(cellId)
      if (occupant === line.factionId) continue // 敌方已驻守，需先战斗
      seen.add(cellId)
      out.push(cellId)
    }
  }
  return out
}

// =============================================================================
// 内部辅助
// =============================================================================

/**
 * 把 cellId 归一为 "col:row" 形式，兼容两种命名风格：
 * - "col:row"（运行时单位坐标派生）
 * - "cell-{col}-{row}"（凡尔登等战役包 map.ts 风格）
 *
 * 未知格式原样返回（确定性失败：不阻断结算，但匹配可能 miss）。
 */
function normalizeCellId(cellId: string): string {
  if (/^-?\d+:-?\d+$/.test(cellId)) return cellId
  const m = /^cell-(\d+)-(\d+)$/.exec(cellId)
  if (m) return `${m[1]}:${m[2]}`
  return cellId
}

// 重新导出常量供 worker / physics-rules 共用
export { normalizeCellId as _normalizeCellIdForTest }

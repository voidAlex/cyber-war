/**
 * 情报可见性渲染决策（intel-visibility.ts）— 纯函数，无 PixiJS 依赖。
 *
 * 把「某单位对某观察方的情报级别（IntelLevel）+ 残影状态」翻译成
 * 「沙盘该如何画这个单位」的渲染指令。PixiJS 渲染层（SandboxRenderer）
 * 只消费这里的产物，自身不做可见性/残影判定逻辑——保证纯逻辑可单测。
 *
 * 情报四级（数大=清晰，PRD §6 统一）：
 * - L0 盲区：完全不显示（玩家不知道该单位存在）。
 * - L1 热力脉冲：仅在所在 cell 显示模糊热力（半透明色块/脉冲），不显示军标。
 * - L2 编制确认：虚线边框军标 + 单位类型（不知精确血量）。
 * - L3 全量透视：实心军标 + 精确 strength/fuel/ammo。
 *
 * 半衰残影：超 halfLifeTurns 未持续侦察 → 半透明残影 + 时间戳标签 [T-Nh]。
 *
 * @module layers/ui/sandbox/intel-visibility
 */

import type {
  Faction,
  IntelLevel,
  Unit,
  UnitIntelSnapshot,
} from '@/types'

/**
 * 某单位对某观察方的渲染模式（情报渲染纯产物）。
 *
 * SandboxRenderer 据此选择绘制方式；自身不做级别判定。
 */
export type IntelRenderMode =
  | 'hidden' // L0 盲区：不画
  | 'heat-pulse' // L1 热力脉冲：模糊色块
  | 'formation' // L2 编制确认：虚线边框 + 类型，无精确数值
  | 'full' // L3 全量透视：实心 + 精确数值
  | 'own' // 己方单位：恒全量透视（不做情报判定）

/**
 * 某单位的情报渲染决策（纯产物，喂给 Pixi 渲染层）。
 */
export interface IntelRenderDecision {
  /** 单位 id */
  unitId: string
  /** 渲染模式 */
  mode: IntelRenderMode
  /** 该单位对观察方的当前情报级别（己方=3） */
  level: IntelLevel
  /** 是否处于残影态（超半衰） */
  ghost: boolean
  /** 残影标记 N（[T-Nh] 中的 N；ghost=false 时为 0） */
  ghostTurns: number
  /** 距上次侦察的回合数（己方=0） */
  staleTurns: number
  /** 最后一次被侦察命中的回合索引（己方=当前回合） */
  lastSeenTurn: number
}

/**
 * 决定单个单位对某观察方的渲染模式（底层原语）。
 *
 * - 己方单位（unit.factionId === observerFactionId）→ 'own'
 * - L0 → 'hidden'
 * - L1 → 'heat-pulse'
 * - L2 → 'formation'
 * - L3 → 'full'
 *
 * @param unit 单位
 * @param observerFactionId 观察方阵营 id
 * @param fallbackLevel 无观测记录时的默认级别（敌方默认 L0 盲区）
 */
export function decideRenderMode(
  unit: Unit,
  observerFactionId: string,
  fallbackLevel: IntelLevel = 0,
): IntelRenderMode {
  // 己方单位恒全量透视
  if (unit.factionId === observerFactionId) return 'own'
  const obs = unit.detection[observerFactionId]
  const level = obs?.level ?? fallbackLevel
  switch (level) {
    case 0:
      return 'hidden'
    case 1:
      return 'heat-pulse'
    case 2:
      return 'formation'
    default:
      return 'full'
  }
}

/**
 * 取观察方对某单位的情报观测产物（level + 残影状态）。
 *
 * 己方单位：level=3、ghost=false、staleTurns=0、lastSeenTurn=currentTurn。
 * 无观测记录：默认 L0 盲区。
 *
 * @param unit 单位
 * @param observerFactionId 观察方阵营 id
 * @param currentTurn 当前回合（用于计算残影）
 * @param halfLifeTurns 半衰回合数（默认 3）
 */
export function computeIntelRender(
  unit: Unit,
  observerFactionId: string,
  currentTurn: number,
  halfLifeTurns = 3,
): IntelRenderDecision {
  // 己方单位：恒全量透视，无残影
  if (unit.factionId === observerFactionId) {
    return {
      unitId: unit.id,
      mode: 'own',
      level: 3,
      ghost: false,
      ghostTurns: 0,
      staleTurns: 0,
      lastSeenTurn: currentTurn,
    }
  }

  const obs = unit.detection[observerFactionId]
  if (obs === undefined) {
    // 无观测记录：盲区，但单位实际存在（仅 UI 不显示）
    return {
      unitId: unit.id,
      mode: 'hidden',
      level: 0,
      ghost: false,
      ghostTurns: 0,
      staleTurns: currentTurn, // 视为从未被侦察
      lastSeenTurn: 0,
    }
  }

  const level = obs.level
  const staleTurns = Math.max(0, currentTurn - obs.lastSeenTurn)
  const ghostTurns = staleTurns >= halfLifeTurns ? Math.floor(staleTurns / halfLifeTurns) : 0
  const ghost = ghostTurns > 0

  return {
    unitId: unit.id,
    mode: decideRenderMode(unit, observerFactionId, level),
    level,
    ghost,
    ghostTurns,
    staleTurns,
    lastSeenTurn: obs.lastSeenTurn,
  }
}

/**
 * 残影时间戳标签（[T-Nh]），无残影返回空串。
 *
 * 例：currentTurn=10、lastSeenTurn=5、halfLifeTurns=3 → stale=5 → N=1 → "[T-1h]"。
 *
 * @param decision 渲染决策
 */
export function ghostLabel(decision: IntelRenderDecision): string {
  if (!decision.ghost) return ''
  return `[T-${decision.ghostTurns}h]`
}

/**
 * 计算残影态下的渲染透明度（0..1）。
 *
 * 残影越久（ghostTurns 越大）越淡：基础 0.45，每多一个半衰 -0.1，下限 0.15。
 *
 * @param decision 渲染决策
 */
export function ghostAlpha(decision: IntelRenderDecision): number {
  if (!decision.ghost) return 1
  const alpha = 0.45 - (decision.ghostTurns - 1) * 0.1
  return Math.max(0.15, alpha)
}

/**
 * 各渲染模式下对玩家可见的字段子集（情报裁剪，供看板/详情展示）。
 *
 * - L0：空（什么都看不到）
 * - L1：仅存在性（位置 + 阵营）
 * - L2：+ 类型 + 坐标（编制确认，无精确数值）
 * - L3 / 己方：全字段（strength/fuel/ammo/personnel/morale/fatigue）
 *
 * @param decision 渲染决策
 */
export function visibleFieldsFor(decision: IntelRenderDecision): readonly string[] {
  switch (decision.mode) {
    case 'hidden':
      return []
    case 'heat-pulse':
      return ['coord', 'faction']
    case 'formation':
      return ['coord', 'faction', 'type']
    case 'full':
    case 'own':
      return [
        'coord',
        'faction',
        'type',
        'strength',
        'fuel',
        'ammo',
        'personnel',
        'morale',
        'fatigue',
      ]
    default:
      return []
  }
}

/**
 * 过滤出观察方「能感知到存在」的单位（排除 L0 盲区 + 己方）。
 *
 * 供情报置信度看板使用（只展示玩家对敌方的情报）。
 *
 * @param units 全部单位
 * @param observerFactionId 观察方阵营 id
 * @param currentTurn 当前回合
 * @param halfLifeTurns 半衰回合数（默认 3）
 */
export function listObservedEnemyUnits(
  units: ReadonlyArray<Unit>,
  observerFactionId: string,
  currentTurn: number,
  halfLifeTurns = 3,
): Array<Unit & { render: IntelRenderDecision }> {
  return units
    .filter((u) => u.factionId !== observerFactionId)
    .map((u) => ({ ...u, render: computeIntelRender(u, observerFactionId, currentTurn, halfLifeTurns) }))
    .filter((u) => u.render.mode !== 'hidden')
}

/**
 * 把 Unit + 渲染决策浓缩为情报快照（写日志/看板摘要用）。
 */
export function toIntelSnapshot(
  unit: Unit,
  observerFactionId: string,
  currentTurn: number,
  halfLifeTurns = 3,
): UnitIntelSnapshot {
  const render = computeIntelRender(unit, observerFactionId, currentTurn, halfLifeTurns)
  return {
    unitId: unit.id,
    level: render.level,
    staleTurns: render.ghost ? render.staleTurns : 0,
    visibleFields: visibleFieldsFor(render),
  }
}

/**
 * 取玩家阵营 id（首个 side=player 的 faction）。
 *
 * Sandbox/看板共用；无玩家阵营返回空串。
 */
export function getPlayerFactionId(
  factions: ReadonlyArray<Faction>,
): string {
  return factions.find((f) => f.side === 'player')?.id ?? ''
}

/**
 * recon 命中：是否需要刷新某单位的情报（玩家未观察或级别更低）。
 *
 * 渲染层在动画 tick 中可据此判定是否触发脉冲反馈。
 */
export function shouldRefreshOnRecon(
  unit: Unit,
  observerFactionId: string,
  gainedLevel: IntelLevel,
): boolean {
  if (unit.factionId === observerFactionId) return false
  const cur = unit.detection[observerFactionId]?.level ?? 0
  return gainedLevel > cur
}

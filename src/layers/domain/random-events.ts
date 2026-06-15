/**
 * 战役随机事件（random-events.ts）— 纯函数。
 *
 * 对应重写计划「第 2 批：战役随机事件」。
 *
 * 设计（确定性 + 不伪造 + 复用 DirectorOverride 链路）：
 * - **确定性根**：rollRandomEvents 用 `DeterministicRandom.fromSequence(scenarioSeed, turn, 9999)`
 *   派生 RNG。相同 (scenarioSeed, turn, rules) → 相同事件集合 + 相同效果。
 *   回放采信 event-log（random_event 标 source:'director'，不重算）。
 * - **触发判定**：按模板 weight 概率 + triggerCondition（always/morale_below/turn_in）+ turnRange
 *   过滤候选池，逐模板用 RNG.chance(weight) 独立判定（互不干扰，确定性序与模板顺序一致）。
 * - **效果解析**：effects 模板（声明式 selector）用 RNG 解析为具体单位，
 *   产出 DirectorOverride[]（field=units.<unitId>.<field>），复用 director 覆写链路。
 * - **不伪造**：effects 只改 world.units 已存在的单位（reinforcement 例外，
 *   单位来自战役包 reinforcementUnits 定义，注入后即可被 effects 引用）。
 *
 * @module layers/domain/random-events
 */

import type {
  WorldState,
  Unit,
  RandomEventTemplate,
  RandomEvent,
  RandomEventEffectTemplate,
  RandomEventTriggerCondition,
} from '@/types'
import type { DirectorOverride } from '@/layers/agents/protocol/schema'
import { DeterministicRandom } from './deterministic-random'

/**
 * 随机事件 RNG 专用 sequence 槽位（与导演部段位 3000+ 区分）。
 *
 * 用 9999 是「事件级」确定性根：与 envelope sequence 解耦，
 * 保证即使本回合 envelope 数量变化，事件判定结果仍稳定（仅依赖 seed+turn）。
 */
export const RANDOM_EVENT_SEQUENCE = 9999

/**
 * 用模板的声明式效果 + 当前 world 解析为具体 DirectorOverride[]。
 *
 * 解析流程（确定性）：
 * 1. 按 targetKind 筛选目标单位集合（all/faction/region/specific）。
 * 2. 按 filterField/filterBelow 二次过滤（如 morale<30）。
 * 3. singleTarget 时用 RNG 按权重挑一个（确定性）。
 * 4. 每个命中单位生成一条 DirectorOverride（field=units.<unitId>.<field>，
 *    before=单位当前值，after=op 应用后值，reason=模板说明）。
 *
 * 不伪造：仅当单位真实存在于 world.units 时才产出覆写。
 *
 * @param template 效果模板
 * @param world 当前世界状态（只读，用于查询单位当前值）
 * @param rng 注入的确定性随机
 */
export function resolveEffectTemplate(
  template: RandomEventEffectTemplate,
  world: WorldState,
  rng: DeterministicRandom,
): DirectorOverride[] {
  const candidates = selectTargetUnits(template, world)
  if (candidates.length === 0) return []

  // singleTarget：按权重随机挑一个（确定性）
  const targets = template.singleTarget
    ? [pickSingle(candidates, rng)]
    : candidates

  const overrides: DirectorOverride[] = []
  for (const unit of targets) {
    const before = readUnitField(unit, template.field)
    if (before === undefined) continue // 字段不存在，跳过（绝不伪造）
    const after = applyOp(before, template.op, template.value, template.field)
    overrides.push({
      field: `units.${unit.id}.${template.field}`,
      before,
      after,
      reason: template.reason,
    })
  }
  return overrides
}

/**
 * 按模板的 targetKind + filter 筛选目标单位集合。
 */
function selectTargetUnits(
  template: RandomEventEffectTemplate,
  world: WorldState,
): Unit[] {
  let pool: Unit[]
  switch (template.targetKind) {
    case 'all':
      pool = world.units
      break
    case 'faction':
      pool = world.units.filter((u) => u.factionId === template.factionId)
      break
    case 'region':
      pool = world.units.filter((u) => {
        if (!template.coord) return false
        const radius = template.radius ?? 0
        const dist =
          Math.abs(u.coord.col - template.coord.col) +
          Math.abs(u.coord.row - template.coord.row)
        return dist <= radius
      })
      break
    case 'specific': {
      if (!template.unitIds) return []
      const idSet = new Set(template.unitIds)
      pool = world.units.filter((u) => idSet.has(u.id))
      break
    }
    default:
      return []
  }

  // filterField/filterBelow 二次过滤（如 morale<30 才候选）
  if (template.filterField && template.filterBelow !== undefined) {
    pool = pool.filter((u) => {
      const v = readUnitField(u, template.filterField!)
      return typeof v === 'number' && v < template.filterBelow!
    })
  }
  return pool
}

/**
 * 按权重从候选池随机挑一个单位（确定性，等权 fallback）。
 *
 * 候选为空时返回 undefined 占位（上层 resolveEffectTemplate 会跳过）。
 * 等权挑选：用 nextInt(0, len-1) 索引，保证相同 seed → 相同选择。
 */
function pickSingle(units: Unit[], rng: DeterministicRandom): Unit {
  // 候选非空已由调用方保证（resolveEffectTemplate 早 return）；防御兜底取首个
  if (units.length === 1) return units[0]
  const idx = rng.nextInt(0, units.length - 1)
  return units[idx]
}

/**
 * 读取单位字段值（限定为 Unit 的数值字段）。
 *
 * @returns 字段值；非数值字段或不存在返回 undefined
 */
function readUnitField(unit: Unit, field: string): number | undefined {
  const record = unit as unknown as Record<string, unknown>
  const v = record[field]
  return typeof v === 'number' ? v : undefined
}

/**
 * 应用 op 到字段值（set 直接覆盖；add 增量并按字段 clamp 到合法区间）。
 *
 * clamp 规则：strength/morale/fuel/ammo/fatigue 均为 0..100；
 * personnel 为 0..maxPersonnel。
 */
function applyOp(
  before: number,
  op: 'set' | 'add',
  value: number,
  field: string,
): number {
  const raw = op === 'set' ? value : before + value
  return clampField(raw, field)
}

/**
 * 按字段语义 clamp 到合法区间。
 *
 * - strength/morale/fuel/ammo：[0, 100]
 * - fatigue：[0, 100]
 * - personnel：[0, +∞)（maxPersonnel 由调用方/上层约束，此处只保非负）
 * - 其它字段：原值返回（不伪造约束边界）
 */
function clampField(raw: number, field: string): number {
  if (Number.isNaN(raw)) return raw
  switch (field) {
    case 'strength':
    case 'morale':
    case 'fuel':
    case 'ammo':
    case 'fatigue':
      return Math.max(0, Math.min(100, Math.round(raw)))
    case 'personnel':
      return Math.max(0, Math.round(raw))
    default:
      return raw
  }
}

/**
 * 判定模板是否在当前回合满足候选条件（triggerCondition + turnRange）。
 *
 * - turnRange：回合不在范围内直接排除。
 * - triggerCondition：
 *   - 'turn_in'：回合在 turns 列表内才候选（不参与 weight 概率，命中即触发）。
 *   - 'morale_below'：阵营平均士气 < moraleThreshold 才候选。
 *   - 'always'：在 turnRange 内恒候选。
 *
 * @returns { candidate: 是否进入概率判定; forceTrigger: turn_in 命中时强制触发 }
 */
function evaluateTrigger(
  template: RandomEventTemplate,
  world: WorldState,
  turn: number,
): { candidate: boolean; forceTrigger: boolean } {
  // turnRange 过滤
  if (template.turnRange) {
    const [start, end] = template.turnRange
    if (turn < start || turn > end) {
      return { candidate: false, forceTrigger: false }
    }
  }

  const cond: RandomEventTriggerCondition = template.triggerCondition ?? {
    kind: 'always',
  }

  if (cond.kind === 'turn_in') {
    const turns = cond.turns ?? []
    if (turns.includes(turn)) {
      return { candidate: false, forceTrigger: true }
    }
    return { candidate: false, forceTrigger: false }
  }

  if (cond.kind === 'morale_below') {
    const factionId = cond.factionId
    const threshold = cond.moraleThreshold ?? 0
    if (!factionId) return { candidate: false, forceTrigger: false }
    const factionUnits = world.units.filter((u) => u.factionId === factionId)
    if (factionUnits.length === 0) return { candidate: false, forceTrigger: false }
    const avgMorale =
      factionUnits.reduce((s, u) => s + u.morale, 0) / factionUnits.length
    return { candidate: avgMorale < threshold, forceTrigger: false }
  }

  // always
  return { candidate: true, forceTrigger: false }
}

/**
 * 触发单个事件模板：注入援军 + 解析 effects。
 *
 * reinforcement：把 template.reinforcementUnits 注入 world.units（不可变产出）。
 *   注入后援军即可被 effects 的 specific targetKind 引用。
 *
 * 返回 { event, world }：event 含已解析 effects；world 含援军（用于回放注入留痕）。
 *
 * @param template 事件模板
 * @param world 当前世界状态（只读）
 * @param turn 触发回合
 * @param rng 注入的确定性随机
 */
function triggerEvent(
  template: RandomEventTemplate,
  world: WorldState,
  turn: number,
  rng: DeterministicRandom,
): { event: RandomEvent; worldWithReinforcement: WorldState } {
  // reinforcement：注入援军单位（不可变，深拷贝 units）
  let worldWithReinforcement = world
  let reinforcementUnitIds: string[] | undefined
  let reinforcementUnits: import('@/types').CampaignUnit[] | undefined
  if (template.kind === 'reinforcement' && template.reinforcementUnits?.length) {
    const existing = new Set(world.units.map((u) => u.id))
    const freshTemplates = template.reinforcementUnits.filter(
      (ru) => !existing.has(ru.id),
    )
    const fresh = freshTemplates.map((ru) => ({
      id: ru.id,
      factionId: ru.factionId,
      type: ru.type,
      coord: { col: ru.coord.col, row: ru.coord.row },
      strength: ru.strength,
      personnel: ru.personnel,
      maxPersonnel: ru.maxPersonnel,
      fuel: ru.fuel,
      ammo: ru.ammo,
      morale: ru.morale,
      fatigue: ru.fatigue,
      detection: {},
      orders: [],
      status: ru.status ? [...ru.status] : [],
    }))
    if (fresh.length > 0) {
      worldWithReinforcement = {
        ...world,
        units: [...world.units, ...fresh],
      }
      reinforcementUnitIds = fresh.map((u) => u.id)
      // 保留完整 CampaignUnit 定义（供 event-log 持久化 + 回放重建）
      reinforcementUnits = freshTemplates
    }
  }

  // 解析 effects（用注入援军后的 world，保证 specific 可引用新单位）
  const effects: DirectorOverride[] = []
  for (const eff of template.effects) {
    effects.push(...resolveEffectTemplate(eff, worldWithReinforcement, rng))
  }

  return {
    event: {
      id: template.id,
      kind: template.kind,
      turn,
      label: template.label,
      description: template.description,
      effects,
      reinforcementUnitIds,
      reinforcementUnits,
    },
    worldWithReinforcement,
  }
}

/**
 * 主入口：基于 rules.randomEvents + 确定性随机判定本回合触发的随机事件。
 *
 * 流程（确定性）：
 * 1. 用 DeterministicRandom.fromSequence(scenarioSeed, turn, 9999) 构造 RNG。
 * 2. 逐模板（按 rules 顺序，确定性序）：
 *    - evaluateTrigger 判定候选/强制触发。
 *    - forceTrigger（turn_in 命中）→ 直接触发。
 *    - candidate=true → RNG.chance(weight) 独立判定。
 *    - 触发则 triggerEvent：注入援军 + 解析 effects，并把援军后的 world 透传给后续模板
 *      （保证 reinforcement 注入的单位可被后续 effects 引用，确定性链式）。
 * 3. 返回 RollRandomEventsResult（events + 待应用援军单位）。
 *
 * **不伪造**：effects 仅引用 world.units 真实单位（reinforcement 注入后也算真实）。
 * 援军单位来自战役包 reinforcementUnits 定义（非凭空创造）。
 *
 * 调用方（orchestrator）职责：把 reinforcements 应用到真实 worldState（rollRandomEvents
 * 本身是纯函数，不修改入参 world）。
 *
 * @param world 当前世界状态（只读）
 * @param turn 结算回合
 * @param rules 战役规则（含 randomEvents 模板）
 * @param scenarioSeed 场景固定种子
 * @returns { events: 触发的随机事件数组; reinforcements: 待应用的援军单位列表 }
 */
export function rollRandomEvents(
  world: WorldState,
  turn: number,
  rules: { randomEvents?: RandomEventTemplate[] },
  scenarioSeed: string,
): RollRandomEventsResult {
  const templates = rules.randomEvents
  if (!templates || templates.length === 0) {
    return { events: [], reinforcements: [] }
  }

  // 确定性根：scenarioSeed:turn:9999（与 envelope sequence 解耦）
  const rng = DeterministicRandom.fromSequence(scenarioSeed, turn, RANDOM_EVENT_SEQUENCE)

  const triggered: RandomEvent[] = []
  // 援军注入链：每个 reinforcement 触发后 world 滚动更新（链式确定性）
  let rollingWorld = world
  const reinforcements: import('@/types').CampaignUnit[] = []

  for (const template of templates) {
    const { candidate, forceTrigger } = evaluateTrigger(template, rollingWorld, turn)
    if (!candidate && !forceTrigger) continue

    // forceTrigger（turn_in 命中）跳过概率判定；否则 weight 概率判定
    const fire = forceTrigger || rng.chance(template.weight)
    if (!fire) continue

    const { event, worldWithReinforcement } = triggerEvent(
      template,
      rollingWorld,
      turn,
      rng,
    )
    triggered.push(event)
    // 援军单位收集：把 rollingWorld → worldWithReinforcement 的新增单位记录下来
    if (worldWithReinforcement.units.length > rollingWorld.units.length) {
      const oldIds = new Set(rollingWorld.units.map((u) => u.id))
      const freshTemplate = template.reinforcementUnits?.filter(
        (ru) => !oldIds.has(ru.id),
      )
      if (freshTemplate) reinforcements.push(...freshTemplate)
    }
    rollingWorld = worldWithReinforcement
  }

  return { events: triggered, reinforcements }
}

/**
 * rollRandomEvents 返回值：触发的随机事件 + 待应用援军单位。
 *
 * reinforcements 是 CampaignUnit[]（来自模板的 reinforcementUnits，非运行时单位），
 * 调用方负责转换为 Unit 并注入 worldState.units（含 detection/orders/status 初始化）。
 */
export interface RollRandomEventsResult {
  /** 触发的随机事件（已解析 effects） */
  events: RandomEvent[]
  /** 待应用援军单位（来自模板定义，调用方负责注入 worldState） */
  reinforcements: import('@/types').CampaignUnit[]
}

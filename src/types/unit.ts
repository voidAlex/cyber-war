/**
 * 单位类型定义
 *
 * 单位是沙盘上可移动/可交战的最小实体。包含战斗力、人员、燃料/弹药、
 * 士气、疲劳、各方对其的情报观测（detection）、命令队列与状态。
 *
 * @module types/unit
 */

import type { IntelLevel, IntelObservation } from './intelligence'

/**
 * 单位类型枚举（影响数值规则与图标）。
 *
 * 第 5 批扩展：陆海空导弹四域。
 * - land 域（既有）：infantry/armor/artillery/recon/fortress/support。
 * - air：空军（可跨格攻击，不受目标格 movementCost 影响）。
 * - naval：海军（仅水域可驻留/机动）。
 * - missile：导弹部队（超远程一回合攻击，弹药消耗巨大）。
 */
export type UnitType =
  | 'infantry' // 步兵
  | 'armor' // 装甲
  | 'artillery' // 炮兵
  | 'recon' // 侦察
  | 'fortress' // 要塞守备（高防御加成）
  | 'support' // 后勤/支援
  | 'air' // 空军（跨格攻击，不受地形阻挡）
  | 'naval' // 海军（仅水域机动/驻留）
  | 'missile' // 导弹部队（超远程一回合打击）

/**
 * 装备槽（第 5 批）。
 *
 * 一个单位可挂载多类装备（步枪/机枪/榴弹炮/坦克炮/航空炸弹/舰炮/导弹等），
 * 数量与品质共同影响火力加成（见 physics-rules.computeEquipmentFirepowerBonus）。
 */
export interface EquipmentSlot {
  /** 装备类型标识（自由字符串，如 'rifle'/'machine-gun'/'howitzer'/'bomb'/'naval-gun'/'missile'） */
  type: string
  /** 装备数量（编制内件数） */
  count: number
  /** 品质 0..1（0=老旧，1=精良；影响火力加成幅度） */
  quality: number
}

/**
 * 坐标（网格坐标，整数列/行）。
 */
export interface GridCoord {
  /** 列（x） */
  col: number
  /** 行（y） */
  row: number
}

/**
 * 单位当前状态标记（可叠加，影响结算）。
 */
export type UnitStatusFlag =
  | 'engaged' // 交战中
  | 'suppressed' // 被炮击压制
  | 'pinned' // 被钉住（无法机动）
  | 'retreating' // 撤退中
  | 'low_supply' // 低补给
  | 'decoy' // 诱饵/欺骗单位
  | 'routed' // 溃退中（T1-D：morale<15 且 strength<30 触发，向己方补给源方向移一格）

/**
 * 单位接口。
 *
 * detection 按 observerFactionId 索引，记录各方对此单位的情报观测。
 */
export interface Unit {
  /** 单位唯一标识符 */
  id: string
  /** 所属阵营 id */
  factionId: string
  /** 单位类型 */
  type: UnitType
  /** 当前网格坐标 */
  coord: GridCoord
  /** 战斗力（0..100，受人员/装备影响） */
  strength: number
  /** 人员数（0..maxPersonnel） */
  personnel: number
  /** 人员上限 */
  maxPersonnel: number
  /** 燃料（0..100，机动单位消耗） */
  fuel: number
  /** 弹药（0..100，交战/炮击消耗） */
  ammo: number
  /** 士气（0..100，影响抗性与服从） */
  morale: number
  /** 疲劳（0..100，越高越低效，回合推进可恢复） */
  fatigue: number
  /**
   * 各方对此单位的情报观测：key=observerFactionId，value=IntelObservation。
   * 己方单位默认 L3 全量透视，敌方按侦察结果填充。
   */
  detection: Record<string, IntelObservation>
  /** 已下达但尚未结算的命令队列（ActionEnvelope 引用） */
  orders: string[]
  /** 当前状态标记集合 */
  status: UnitStatusFlag[]
  /**
   * 装备槽列表（第 5 批，可选）。
   *
   * 影响火力加成（见 physics-rules.computeEquipmentFirepowerBonus）。
   * 缺省视为无装备加成（火力仅由 strength/type/ammo 决定，保持旧存档兼容）。
   */
  equipment?: EquipmentSlot[]
  /** 是否为欺骗/诱饵单位（director 可用，影响情报与结算） */
  deception?: boolean
  /**
   * 工事/战壕等级（T1-A，0..3，缺省 0）。
   *
   * 由 'entrench' 命令提升（resolveEntrenchOrder：每回合 +1，封顶 3）。
   * 影响战斗防御（computeEffectiveDefense：每级 +0.15）。
   * 单位离开当前格时工事仍保留在 cell.fortificationLevel 上（一格后衰减 -1）。
   * 旧存档缺省视为 0（兼容回填）。
   */
  entrenchment?: number
}

/**
 * 单位被某方观测到的快照（情报渲染用，按 IntelLevel 截断信息）。
 */
export interface UnitIntelSnapshot {
  /** 单位 id */
  unitId: string
  /** 观测方所见情报级别 */
  level: IntelLevel
  /** 残影标记回合数（T-Nh），无残影为 0 */
  staleTurns: number
  /** 该级别下可见的字段子集（L0=空，L3=全字段） */
  visibleFields: readonly string[]
}

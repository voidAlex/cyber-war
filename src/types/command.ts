/**
 * 命令解析类型契约（command）。
 *
 * 参谋长（chief）把玩家自然语言解析为结构化的 ParsedCommand（move/attack/
 * capture_node/hold），或返回 ClarifyRequest 请求澄清（解析失败/模糊时）。
 *
 * 设计要点（审计教训「解析失败伪造 unit-1/C3」）：
 * - 解析必须基于真实 WorldState.units/map.highValueNodes 校验目标存在，
 *   找不到目标绝不伪造兜底数据，而是返回 ClarifyRequest。
 * - 接口设计成 `parseCommand(input, ctx): Promise<ParsedCommand | ClarifyRequest>`，
 *   M2 用规则/mock 实现，M3 替换为真 LLM 时接口不变。
 *
 * ParsedCommand 与 ActionEnvelope 的关系：
 * - ParsedCommand：解析产物（chief 的输出，待握手确认）。
 * - ActionEnvelope：玩家确认后入队的命令信封（payload 用 ParsedCommand 字段填充）。
 *
 * @module types/command
 */

import type { GridCoord } from './unit'

/**
 * 命令意图（与 worker normalizeIntent / physics-rules 对齐）。
 *
 * - move：机动到目标坐标
 * - attack：攻击指定敌方单位
 * - capture_node：占领高价值节点
 * - hold：原地固守（不结算移动/交战）
 * - recon：主动侦察/间谍——对目标坐标或目标单位执行侦察，
 *   命中后刷新该方对其的情报等级（调 intelligence.refreshOnRecon）。
 * - entrench：构筑工事/挖战壕（T1-A）——单位就地不动，entrenchment +1（封顶 3），
 *   同步提升所在格 cell.fortificationLevel + morale +2（专注工事）；产出 'entrench' 事件。
 *   每级 entrenchment 在战斗结算时给单位 +0.15 防御加成；cell.fortificationLevel 给 +0.1。
 *
 * T2 第 2 批（电子战）：
 * - ew_jam：电子干扰——EW 单位对目标坐标范围内的敌方单位施加 intel level 降级；
 *   产出 'ew_jam' 事件。
 * - ew_support：电子支援——EW 单位增强己方侦察单位 detection level；
 *   产出 'ew_support' 事件。
 *
 * T2 第 3 批（舆论战）：
 * - propaganda：宣传/舆论——提升 targetFaction publicWill+5 或 ownFaction morale+3；
 *   产出 'propaganda' 事件。
 *
 * T2 第 4 批（特殊作战）：
 * - sabotage：破坏——特种单位（recon/infantry 携 special 装备）破坏目标 cell
 *   （supplySource → fortificationLevel-2；cell 有单位 → strength-15）；需 recon level≥L2。
 * - paradrop：空降——type air 单位直接跳到目标 cell（无视 terrain/movementCost），
 *   strength-15 + status 'pinned' 1 回合（空降散降）。
 * - commando_raid：特种突袭/斩首——针对敌方 commander cell，成功则该 cell 所有单位 morale-20。
 *
 * T3-B（地形改造）：
 * - build_bridge：架桥——type support/engineer 单位在水域 cell 上建桥（cell.bridge=true），
 *   使陆地单位可通行该水域格（movementCost=2）。产出 'build' 事件。
 * - destroy_bridge：炸桥——破坏 cell.bridge（bridge=false），阻断渡河。
 *   产出 'destroy' 事件。
 * - build_road：修路——在非水域 cell 修路（cell.road=true，movementCost 减半，min 1）。
 *   产出 'build' 事件。
 */
export type CommandIntent =
  | 'move'
  | 'attack'
  | 'capture_node'
  | 'hold'
  | 'recon'
  | 'entrench'
  | 'ew_jam' // T2 第 2 批：电子干扰
  | 'ew_support' // T2 第 2 批：电子支援
  | 'propaganda' // T2 第 3 批：宣传/舆论
  | 'sabotage' // T2 第 4 批：破坏
  | 'paradrop' // T2 第 4 批：空降
  | 'commando_raid' // T2 第 4 批：特种突袭/斩首
  | 'build_bridge' // T3-B：架桥（水域 cell.bridge=true）
  | 'destroy_bridge' // T3-B：炸桥（cell.bridge=false）
  | 'build_road' // T3-B：修路（cell.road=true，movementCost 减半）

/**
 * 参谋长解析成功的结构化命令。
 *
 * targetUnitIds：move/attack/capture 时为执行单位；hold 时为固守单位。
 * targetCoord：move 的目标格；capture_node 时为节点所在格（可选，渲染预演用）。
 * targetUnitId（attack）：被攻击的敌方单位。
 * nodeId（capture_node）：高价值节点 id。
 */
export interface ParsedCommand {
  /** 解析成功标记 */
  kind: 'parsed'
  /** 命令意图 */
  intent: CommandIntent
  /** 执行单位 id 列表（来自真实 WorldState.units，绝不伪造） */
  targetUnitIds: string[]
  /** 目标坐标（move 必填；capture_node 可选） */
  targetCoord?: GridCoord
  /** 被攻击的敌方单位 id（attack 必填） */
  targetUnitId?: string
  /** 高价值节点 id（capture_node 必填） */
  nodeId?: string
  /** 参谋长的自然语言解读说明（显示给玩家，辅助确认） */
  summary: string
  /** 置信度 0..1（mock 按解析匹配度估算） */
  confidence: number
}

/**
 * 解析失败/模糊时的澄清请求（对应审计教训「不伪造兜底」）。
 *
 * reason 说明为何需要澄清，suggestions 列出可执行的建议（如列出可用单位/节点）。
 */
export interface ClarifyRequest {
  /** 解析需澄清标记 */
  kind: 'clarify'
  /** 玩家原始输入 */
  rawInput: string
  /** 需要澄清的原因（人类可读） */
  reason: string
  /** 可选建议列表（可用单位/节点/坐标范围，辅助玩家修改） */
  suggestions: string[]
}

/** 参谋长 parseCommand 的返回（成功或需澄清） */
export type ParseCommandResult = ParsedCommand | ClarifyRequest

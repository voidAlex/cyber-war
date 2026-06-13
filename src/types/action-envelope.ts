/**
 * 命令信封类型定义（ActionEnvelope）
 *
 * 命令是「自然语言意图 + 结构化载荷 + 确定性序号」的统一容器，
 * 贯穿 planning → handshake → locked → resolution 全流程。
 *
 * 重写计划关键防坑：sequence 预分配保证多 Agent 确定性
 * （参谋 0+ / 战区 1000+ / 敌盟 2000+ / 导演 3000+），
 * seed = scenarioSeed:turn:sequence。
 *
 * @module types/action-envelope
 */

/**
 * 命令在生命周期中的状态。
 *
 * - pending：已创建未确认（planning）
 * - confirmed：玩家已确认入队（handshake 完成）
 * - locked：回合锁定，等待结算（locked）
 * - executing：正在结算（resolution）
 * - resolved：已结算并写入 event-log（briefing）
 * - cancelled：被取消（玩家撤回 / director 否决）
 */
export type ActionState =
  | 'pending'
  | 'confirmed'
  | 'locked'
  | 'executing'
  | 'resolved'
  | 'cancelled'

/**
 * Agent 角色枚举（决定 sequence 段与 prompt 模板）。
 */
export type AgentRole = 'chief' | 'theater' | 'commander' | 'director'

/**
 * 命令信封。
 *
 * 一个 ActionEnvelope 描述「某 Agent 在某回合提出的某意图」。
 * 确定性核心字段：sequence（预分配，与调度顺序无关）。
 */
export interface ActionEnvelope {
  /** 所属回合索引 */
  turn: number
  /** 所属阵营 id */
  faction: string
  /** 提出/归属的 Agent id */
  agentId: string
  /** Agent 角色 */
  agentRole: AgentRole
  /**
   * 自然语言意图（玩家或 LLM 输出的原始文本）。
   * 握手阶段解析为 payload。
   */
  intent: string
  /**
   * 结构化载荷（解析后的命令，由 command-parser 填充）。
   * 未解析前为空对象。
   */
  payload: Record<string, unknown>
  /** LLM 置信度（0..1），director 终裁参考 */
  confidence: number
  /** 是否需要玩家确认（handshake 触发） */
  requiresConfirmation: boolean
  /**
   * 确定性序号（预分配）：
   * - chief 段 0+
   * - theater 段 1000+
   * - commander（敌盟）段 2000+
   * - director 段 3000+
   *
   * seed = scenarioSeed:turn:sequence。
   */
  sequence: number
  /** 当前生命周期状态 */
  state: ActionState
}

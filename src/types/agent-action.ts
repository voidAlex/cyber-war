/**
 * Agent 动作类型定义（agent-action）
 *
 * Agent 动作是 LLM/规则引擎产出的、可被领域结算消费的结构化输出。
 * 与 ActionEnvelope 的区别：
 * - ActionEnvelope：命令信封（描述意图与生命周期），偏流程。
 * - AgentAction：Agent 的具体输出（决策/战报/裁定），偏内容。
 *
 * event-log 每条标 source，回放时 physics 类校验重算、director 类直接采信。
 *
 * @module types/agent-action
 */

import type { AgentRole } from './action-envelope'

/**
 * event-log 条目来源（确定性两层）。
 *
 * - physics：纯数值规则产物，回放时校验重算一致。
 * - director：LLM 导演部输出「记录即真相」，回放直接采信不重算。
 * - rule-engine：离线/降级时规则引擎兜底产物（无 LLM 时推进游戏）。
 */
export type EventLogSource = 'physics' | 'director' | 'rule-engine'

/**
 * Agent 动作类别。
 */
export type AgentActionKind =
  | 'order' // 命令（解析自玩家/参谋长）
  | 'decision' // 决策（战区司令/敌盟统帅）
  | 'adjudication' // 终裁（director 覆写数值）
  | 'report' // 战报文本（director 润色）
  | 'query' // 握手反问（chief）

/**
 * Agent 动作接口（写入 event-log 的结构化条目）。
 */
export interface AgentAction {
  /** 全局唯一 id（event-log 主键） */
  id: string
  /** 所属回合 */
  turn: number
  /** 产出方 Agent id */
  agentId: string
  /** Agent 角色 */
  agentRole: AgentRole
  /** 动作类别 */
  kind: AgentActionKind
  /** 产出来源（physics/director/rule-engine） */
  source: EventLogSource
  /** 结构化载荷（具体内容由各 Agent 协议定义） */
  payload: Record<string, unknown>
  /** 自然语言文本（战报/解释，可为空） */
  text?: string
  /** 关联的确定性序号（与 ActionEnvelope.sequence 对齐，便于回放） */
  sequence: number
  /** 产出时使用的确定性种子（scenarioSeed:turn:seq），便于复现 */
  seed: string
}

/**
 * Agent 协议契约的最小输入上下文（L0-L3 缓存分层构造，见 agents/context-builder）。
 * 此接口为各 role 协议的公共输入骨架，具体扩展在各 role 文件。
 */
export interface AgentContext {
  /** L0 角色 system prompt（永不变，必须完全固定） */
  systemPrompt: string
  /** L2 当前世界状态摘要（每回合变一次，同回合多 Agent 共享） */
  worldSummary: string
  /** L3 本条具体指令（每请求变，回合号/时间戳只放这里） */
  instruction: string
  /** 历史 messages（append-only，多轮对话天然命中缓存） */
  history: AgentMessage[]
}

/** 单条对话消息（OpenAI/DeepSeek 兼容格式） */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 参谋长多轮对话历史的一轮（玩家 ↔ 参谋长）。
 *
 * 区别于 AgentMessage：
 * - AgentMessage 是 LLM wire 格式（role: system/user/assistant），用于 prompt 构造。
 * - DialogueTurn 是 UI 与 chief.chat 之间的高层语义（role: player/chief），
 *   反映"指挥官 ↔ 参谋长"两个角色，不暴露 wire role。
 *
 * UI 端把 dialogues 数组映射为 DialogueTurn[] 传给 chief.chat；
 * chief 内部再转 AgentMessage[]（player→user, chief→assistant）注入 L2 层。
 *
 * @field role 'player'（指挥官/玩家发言）或 'chief'（参谋长回复）
 * @field text 该轮的文本内容
 * @field ts 可选时间戳（UI 排序用，LLM 不依赖）
 */
export interface DialogueTurn {
  role: 'player' | 'chief'
  text: string
  ts?: number
}

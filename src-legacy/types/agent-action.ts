/**
 * Agent 行动类型定义
 * 
 * 定义多 Agent 系统的行动协议。
 * 所有 Agent 交互统一使用此格式。
 * 
 * @module types/agent-action
 */

/**
 * Agent 行动意图枚举
 * 
 * 定义 Agent 可能执行的行动类型。
 */
export type AgentIntent = 
  // 机动类
  | 'move'              // 移动
  | 'deploy'            // 部署
  | 'retreat'           // 撤退
  
  // 战斗类
  | 'attack'            // 攻击
  | 'attack_node'       // 攻击节点/据点
  | 'capture_node'      // 占领节点/据点
  | 'defend'            // 防守
  
  // 侦察类
  | 'scout'             // 侦察
  | 'recon'             // 侦察（同 scout）
  
  // 支援类
  | 'resupply'          // 补给
  | 'repair'            // 维修
  | 'heal'              // 治疗
  
  // 外交类
  | 'request_ally'      // 请求盟友支援
  | 'negotiate'         // 谈判
  
  // 其他
  | 'hold'              // 原地待命
  | 'custom'            // 自定义行动

/**
 * Agent 行动载荷
 * 
 * 根据不同的意图类型，载荷结构可能不同。
 */
export interface AgentActionPayload {
  /** 目标节点/位置 */
  node?: string
  
  /** 目标位置坐标 */
  position?: { x: number; y: number }
  
  /** 涉及的单位 ID 列表 */
  units?: string[]
  
  /** 目标单位 ID */
  targetUnitId?: string
  
  /** 目标阵营 ID */
  targetFactionId?: string
  
  /** 其他自定义参数 */
  [key: string]: unknown
}

/**
 * Agent 行动信封
 * 
 * 所有 Agent 交互的统一格式。
 * 这是 Agent 系统与游戏系统之间的通信协议。
 */
export interface AgentAction {
  /** 回合数 */
  turn: number
  
  /** 阵营 ID */
  faction: string
  
  /** Agent ID */
  agentId: string
  
  /** 行动意图 */
  intent: AgentIntent
  
  /** 行动载荷 */
  payload: AgentActionPayload
  
  /** 置信度（0-1） */
  confidence: number
  
  /** 是否需要确认 */
  requiresConfirmation: boolean
  
  /** 行动 ID（唯一标识符） */
  actionId: string
  
  /** 行动描述（人类可读） */
  description?: string
  
  /** 行动时间戳（ISO 8601） */
  timestamp: string
}

/**
 * Agent 角色枚举
 */
export type AgentRole = 
  | 'chief_of_staff'    // 参谋长（玩家侧）
  | 'theater_commander' // 战区司令
  | 'supreme_commander' // 统帅（敌方/盟友）
  | 'director'          // 导演部（裁判）

/**
 * Agent 状态枚举
 */
export type AgentStatus = 
  | 'idle'              // 空闲
  | 'processing'        // 处理中
  | 'waiting'           // 等待输入
  | 'completed'         // 已完成
  | 'failed'            // 失败

/**
 * Agent 信息接口
 */
export interface AgentInfo {
  /** Agent ID */
  id: string
  
  /** Agent 角色 */
  role: AgentRole
  
  /** Agent 名称 */
  name: string
  
  /** 所属阵营 ID */
  factionId: string
  
  /** 当前状态 */
  status: AgentStatus
}

/**
 * Agent 进度状态
 */
export type AgentProgressState =
  | 'queued'
  | 'running'
  | 'streaming'
  | 'completed'
  | 'failed'

export type EnvelopeKind =
  | 'agent_status'
  | 'battle_report_chunk'
  | 'director_final'

export interface DirectorVerdictPayload {
  turn: number
  summary: string
  events: Array<{
    id: string
    type: string
    description: string
    data: Record<string, unknown>
  }>
  stateChanges: Record<string, unknown>
}

export interface ActionEnvelope {
  envelopeId: string
  sequence: number
  turn: number
  factionId: string
  role: AgentRole
  agentId: string
  kind: EnvelopeKind
  state: AgentProgressState
  payload: Record<string, unknown> | DirectorVerdictPayload
  timestamp: string
}

/**
 * 生成唯一行动 ID
 */
export function generateActionId(): string {
  return `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export function generateEnvelopeId(): string {
  return `envelope_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

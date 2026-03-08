/**
 * WEGO 回合状态机
 * 
 * 实现同步回合制的状态流转：
 * idle -> planning -> handshake -> locked -> resolution -> briefing -> persist -> idle
 * 
 * 设计原则：
 * - 确定性：相同输入 + 种子 = 相同输出
 * - 可回放：支持从日志恢复状态
 * - 错误恢复：每个阶段前保存快照
 * 
 * @module game/state-machine
 */

import type { GameState, GamePhase, AgentAction } from '@/types'

/**
 * 状态机动作类型
 */
export type StateMachineAction =
  | { type: 'START_PLANNING' }
  | { type: 'SUBMIT_ORDER'; payload: { order: AgentAction } }
  | { type: 'CANCEL_ORDER'; payload: { orderId: string } }
  | { type: 'CONFIRM_ORDERS' }
  | { type: 'START_HANDSHAKE' }
  | { type: 'CONFIRM_HANDSHAKE' }
  | { type: 'CANCEL_HANDSHAKE' }
  | { type: 'LOCK_ORDERS' }
  | { type: 'START_RESOLUTION' }
  | { type: 'RESOLUTION_COMPLETE'; payload: { results: ResolutionResult } }
  | { type: 'RESOLUTION_FAILED'; payload: { error: string } }
  | { type: 'SHOW_BRIEFING' }
  | { type: 'DISMISS_BRIEFING' }
  | { type: 'PERSIST_STATE' }
  | { type: 'PERSIST_COMPLETE' }
  | { type: 'NEXT_TURN' }
  | { type: 'RESET_TO_IDLE' }
  | { type: 'LOAD_STATE'; payload: { state: GameState } }
  | { type: 'PAUSE_GAME' }
  | { type: 'RESUME_GAME' }

/**
 * 结算结果接口
 */
export interface ResolutionResult {
  /** 回合数 */
  turn: number
  
  /** 事件列表 */
  events: ResolutionEvent[]
  
  /** 状态变更 */
  stateChanges: Record<string, unknown>
  
  /** 是否成功 */
  success: boolean
}

/**
 * 结算事件接口
 */
export interface ResolutionEvent {
  /** 事件 ID */
  id: string
  
  /** 事件类型 */
  type: string
  
  /** 事件描述 */
  description: string
  
  /** 事件数据 */
  data: Record<string, unknown>
}

/**
 * 状态机上下文接口
 */
export interface StateMachineContext {
  /** 当前游戏状态 */
  gameState: GameState
  
  /** 待确认的命令（handshake 阶段） */
  pendingOrders: AgentAction[]
  
  /** 已确认的命令（locked 阶段） */
  confirmedOrders: AgentAction[]
  
  /** 结算结果（briefing 阶段） */
  resolutionResult: ResolutionResult | null
  
  /** 错误信息 */
  error: string | null
  
  /** 是否暂停 */
  isPaused: boolean
  
  /** 状态历史（用于调试和回放） */
  history: StateMachineAction[]
}

/**
 * 有效的阶段转换映射
 */
const VALID_TRANSITIONS: Record<GamePhase, GamePhase[]> = {
  idle: ['planning'],
  planning: ['handshake', 'idle'],
  handshake: ['locked', 'planning'],
  locked: ['resolution'],
  resolution: ['briefing', 'locked'],
  briefing: ['persist'],
  persist: ['idle'],
}

/**
 * 验证阶段转换是否有效
 * 
 * @param from 源阶段
 * @param to 目标阶段
 * @returns 是否有效
 */
export function isValidTransition(from: GamePhase, to: GamePhase): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * 创建初始状态机上下文
 * 
 * @param gameState 游戏状态
 * @returns 状态机上下文
 */
export function createInitialContext(gameState: GameState): StateMachineContext {
  return {
    gameState,
    pendingOrders: [],
    confirmedOrders: [],
    resolutionResult: null,
    error: null,
    isPaused: false,
    history: [],
  }
}

/**
 * WEGO 状态机 Reducer
 * 
 * @param context 当前上下文
 * @param action 动作
 * @returns 新上下文
 */
export function wegoReducer(
  context: StateMachineContext,
  action: StateMachineAction
): StateMachineContext {
  // 记录动作到历史
  const newHistory = [...context.history, action]
  
  // 处理暂停状态
  if (context.isPaused && action.type !== 'RESUME_GAME') {
    return context
  }
  
  switch (action.type) {
    case 'START_PLANNING': {
      if (context.gameState.phase !== 'idle') {
        return {
          ...context,
          error: `无法开始规划：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'planning',
          updatedAt: new Date().toISOString(),
        },
        pendingOrders: [],
        confirmedOrders: [],
        error: null,
        history: newHistory,
      }
    }
    
    case 'SUBMIT_ORDER': {
      if (context.gameState.phase !== 'planning' && context.gameState.phase !== 'handshake') {
        return {
          ...context,
          error: `无法提交命令：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        pendingOrders: [...context.pendingOrders, action.payload.order],
        error: null,
        history: newHistory,
      }
    }
    
    case 'CANCEL_ORDER': {
      return {
        ...context,
        pendingOrders: context.pendingOrders.filter(
          order => order.actionId !== action.payload.orderId
        ),
        error: null,
        history: newHistory,
      }
    }
    
    case 'CONFIRM_ORDERS': {
      return {
        ...context,
        confirmedOrders: [...context.confirmedOrders, ...context.pendingOrders],
        pendingOrders: [],
        error: null,
        history: newHistory,
      }
    }
    
    case 'START_HANDSHAKE': {
      if (!isValidTransition(context.gameState.phase, 'handshake')) {
        return {
          ...context,
          error: `无效的阶段转换：${context.gameState.phase} -> handshake`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'handshake',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'CONFIRM_HANDSHAKE': {
      if (context.gameState.phase !== 'handshake') {
        return {
          ...context,
          error: `无法确认握手：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'locked',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'CANCEL_HANDSHAKE': {
      if (context.gameState.phase !== 'handshake') {
        return {
          ...context,
          error: `无法取消握手：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'planning',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'LOCK_ORDERS': {
      if (context.gameState.phase !== 'handshake') {
        return {
          ...context,
          error: `无法锁定命令：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'locked',
          updatedAt: new Date().toISOString(),
        },
        confirmedOrders: [...context.confirmedOrders, ...context.pendingOrders],
        pendingOrders: [],
        error: null,
        history: newHistory,
      }
    }
    
    case 'START_RESOLUTION': {
      if (!isValidTransition(context.gameState.phase, 'resolution')) {
        return {
          ...context,
          error: `无效的阶段转换：${context.gameState.phase} -> resolution`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'resolution',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'RESOLUTION_COMPLETE': {
      if (context.gameState.phase !== 'resolution') {
        return {
          ...context,
          error: `结算结果无效：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'briefing',
          updatedAt: new Date().toISOString(),
        },
        resolutionResult: action.payload.results,
        error: null,
        history: newHistory,
      }
    }
    
    case 'RESOLUTION_FAILED': {
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'locked', // 回滚到锁定状态
          updatedAt: new Date().toISOString(),
        },
        error: action.payload.error,
        history: newHistory,
      }
    }
    
    case 'SHOW_BRIEFING': {
      if (context.gameState.phase !== 'resolution') {
        return {
          ...context,
          error: `无法显示战报：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'briefing',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'DISMISS_BRIEFING': {
      if (context.gameState.phase !== 'briefing') {
        return {
          ...context,
          error: `无法关闭战报：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'persist',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'PERSIST_STATE': {
      if (context.gameState.phase !== 'briefing') {
        return {
          ...context,
          error: `无法持久化：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'persist',
          updatedAt: new Date().toISOString(),
        },
        error: null,
        history: newHistory,
      }
    }
    
    case 'PERSIST_COMPLETE': {
      if (context.gameState.phase !== 'persist') {
        return {
          ...context,
          error: `持久化完成无效：当前阶段为 ${context.gameState.phase}`,
          history: newHistory,
        }
      }
      
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'idle',
          updatedAt: new Date().toISOString(),
        },
        confirmedOrders: [],
        resolutionResult: null,
        error: null,
        history: newHistory,
      }
    }
    
    case 'NEXT_TURN': {
      return {
        ...context,
        gameState: {
          ...context.gameState,
          turn: context.gameState.turn + 1,
          worldState: {
            ...context.gameState.worldState,
            turnIndex: context.gameState.worldState.turnIndex + 1,
          },
          phase: 'idle',
          updatedAt: new Date().toISOString(),
        },
        pendingOrders: [],
        confirmedOrders: [],
        resolutionResult: null,
        error: null,
        history: newHistory,
      }
    }
    
    case 'RESET_TO_IDLE': {
      return {
        ...context,
        gameState: {
          ...context.gameState,
          phase: 'idle',
          updatedAt: new Date().toISOString(),
        },
        pendingOrders: [],
        confirmedOrders: [],
        error: null,
        history: newHistory,
      }
    }
    
    case 'LOAD_STATE': {
      return {
        ...createInitialContext(action.payload.state),
        history: newHistory,
      }
    }
    
    case 'PAUSE_GAME': {
      return {
        ...context,
        isPaused: true,
        history: newHistory,
      }
    }
    
    case 'RESUME_GAME': {
      return {
        ...context,
        isPaused: false,
        error: null,
        history: newHistory,
      }
    }
    
    default: {
      return {
        ...context,
        error: `未知动作类型`,
        history: newHistory,
      }
    }
  }
}

/**
 * 获取阶段的中文名称
 * 
 * @param phase 游戏阶段
 * @returns 中文名称
 */
export function getPhaseDisplayName(phase: GamePhase): string {
  const names: Record<GamePhase, string> = {
    idle: '空闲',
    planning: '规划',
    handshake: '握手确认',
    locked: '已锁定',
    resolution: '结算中',
    briefing: '战报',
    persist: '持久化',
  }
  return names[phase] ?? phase
}

/**
 * 获取阶段的描述
 * 
 * @param phase 游戏阶段
 * @returns 阶段描述
 */
export function getPhaseDescription(phase: GamePhase): string {
  const descriptions: Record<GamePhase, string> = {
    idle: '等待开始新回合',
    planning: '观察沙盘，与参谋长对话，下达指令',
    handshake: '参谋长反问，预演虚线，玩家确认',
    locked: '双方计划冻结，准备结算',
    resolution: '导演部接管结算',
    briefing: '战报分发，沙盘更新，情报半衰',
    persist: 'JSON 状态落盘，快照',
  }
  return descriptions[phase] ?? ''
}

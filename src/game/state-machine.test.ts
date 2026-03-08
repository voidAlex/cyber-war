/**
 * WEGO 状态机测试
 *
 * 验证状态机的阶段转换和动作处理。
 *
 * @module game/state-machine.test
 */
import { describe, it, expect } from 'vitest';
import { createInitialContext, isValidTransition, wegoReducer, getPhaseDisplayName, getPhaseDescription } from './state-machine';
import type { GameState } from '@/types';
import { GAME_VERSION, createEmptyMap } from '@/types';

/**
 * 创建模拟游戏状态
 */
function createMockGameState(overrides: Partial<GameState> = {}): GameState {
  const now = new Date().toISOString();
  return {
    turn: 1,
    phase: 'idle',
    worldState: {
      turnIndex: 0,
      factions: [],
      units: [],
      map: createEmptyMap(10, 10, 'plain'),
    },
    scenarioSeed: 'test-seed',
    saveId: 'test-save-id',
    createdAt: now,
    updatedAt: now,
    version: GAME_VERSION,
    ...overrides,
  };
}

/**
 * 创建模拟 AgentAction
 */
function createMockOrder(overrides: Partial<import('@/types').AgentAction> = {}): import('@/types').AgentAction {
  return {
    turn: 1,
    faction: 'player',
    agentId: 'test-agent',
    intent: 'move' as const,
    payload: { node: 'C3', units: ['unit-1'] },
    confidence: 0.8,
    requiresConfirmation: true,
    actionId: 'action-1',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('状态机初始化', () => {
  it('应该创建正确的初始上下文', () => {
    const gameState = createMockGameState();
    const context = createInitialContext(gameState);
    
    expect(context.gameState.phase).toBe('idle');
    expect(context.gameState.turn).toBe(1);
    expect(context.pendingOrders).toEqual([]);
    expect(context.confirmedOrders).toEqual([]);
    expect(context.error).toBeNull();
    expect(context.isPaused).toBe(false);
  });
});

describe('阶段转换验证', () => {
  it('应该允许有效的阶段转换', () => {
    expect(isValidTransition('idle', 'planning')).toBe(true);
    expect(isValidTransition('planning', 'handshake')).toBe(true);
    expect(isValidTransition('handshake', 'locked')).toBe(true);
    expect(isValidTransition('locked', 'resolution')).toBe(true);
    expect(isValidTransition('resolution', 'briefing')).toBe(true);
    expect(isValidTransition('briefing', 'persist')).toBe(true);
    expect(isValidTransition('persist', 'idle')).toBe(true);
  });
  
  it('应该禁止无效的阶段转换', () => {
    expect(isValidTransition('idle', 'resolution')).toBe(false);
    expect(isValidTransition('idle', 'locked')).toBe(false);
  });
  
  it('planning 阶段可以回到 idle', () => {
    expect(isValidTransition('planning', 'idle')).toBe(true);
  });
});

describe('START_PLANNING 动作', () => {
  it('应该从 idle 阶段转换到 planning', () => {
    const gameState = createMockGameState();
    const context = createInitialContext(gameState);
    const newState = wegoReducer(context, { type: 'START_PLANNING' });
    
    expect(newState.gameState.phase).toBe('planning');
    expect(newState.error).toBeNull();
  });
  
  it('应该从非 idle 阶段返回错误', () => {
    const gameState = createMockGameState({ phase: 'planning' });
    const context = createInitialContext(gameState);
    const newState = wegoReducer(context, { type: 'START_PLANNING' });
    
    expect(newState.error).toBeDefined();
  });
});

describe('SUBMIT_ORDER 动作', () => {
  it('应该在 planning 阶段添加订单到 pendingOrders', () => {
    const gameState = createMockGameState({ phase: 'planning' });
    const context = createInitialContext(gameState);
    const order = createMockOrder();
    
    const newState = wegoReducer(context, { type: 'SUBMIT_ORDER', payload: { order } });
    
    expect(newState.pendingOrders).toHaveLength(1);
    expect(newState.pendingOrders[0].actionId).toBe('action-1');
  });
  
  it('应该允许在 handshake 阶段添加订单', () => {
    const gameState = createMockGameState({ phase: 'handshake' });
    const context = createInitialContext(gameState);
    const order = createMockOrder();
    
    const newState = wegoReducer(context, { type: 'SUBMIT_ORDER', payload: { order } });
    
    expect(newState.pendingOrders).toHaveLength(1);
  });
  
  it('应该拒绝在其他阶段添加订单', () => {
    const gameState = createMockGameState({ phase: 'locked' });
    const context = createInitialContext(gameState);
    const order = createMockOrder();
    
    const newState = wegoReducer(context, { type: 'SUBMIT_ORDER', payload: { order } });
    
    expect(newState.error).toBeDefined();
  });
});

describe('LOCK_ORDERS 动作', () => {
  it('应该从 handshake 阶段转换到 locked', () => {
    const gameState = createMockGameState({ phase: 'handshake' });
    const context = createInitialContext(gameState);
    context.pendingOrders.push(createMockOrder());
    
    const newState = wegoReducer(context, { type: 'LOCK_ORDERS' });
    
    expect(newState.gameState.phase).toBe('locked');
    expect(newState.pendingOrders).toHaveLength(0);
    expect(newState.confirmedOrders).toHaveLength(1);
  });
  
  it('应该拒绝从非 handshake 阶段锁定', () => {
    const gameState = createMockGameState({ phase: 'planning' });
    const context = createInitialContext(gameState);
    
    const newState = wegoReducer(context, { type: 'LOCK_ORDERS' });
    
    expect(newState.error).toBeDefined();
  });
});

describe('RESOLUTION_COMPLETE 动作', () => {
  it('应该从 resolution 阶段转换到 briefing', () => {
    const gameState = createMockGameState({ phase: 'resolution' });
    const context = createInitialContext(gameState);
    
    const result = {
      turn: 1,
      events: [
        {
          id: 'event-1',
          type: 'battle',
          description: '测试战斗',
          data: { attacker: 'unit-1', defender: 'unit-2' },
        },
      ],
      stateChanges: { unitsDamaged: ['unit-1', 'unit-2'] },
      success: true,
    };
    
    const newState = wegoReducer(context, {
      type: 'RESOLUTION_COMPLETE',
      payload: { results: result },
    });
    
    expect(newState.gameState.phase).toBe('briefing');
    expect(newState.resolutionResult).toEqual(result);
    expect(newState.error).toBeNull();
  });
});

describe('无效阶段转换', () => {
  it('应该拒绝从 locked 直接跳到 resolution', () => {
    const gameState = createMockGameState({ phase: 'idle' });
    const context = createInitialContext(gameState);
    
    const newState = wegoReducer(context, { type: 'START_RESOLUTION' });
    
    expect(newState.gameState.phase).toBe('idle');
    expect(newState.error).toBeDefined();
    expect(newState.history.length).toBe(1);
  });
});

describe('加载状态', () => {
  it('应该正确加载新状态', () => {
    const gameState1 = createMockGameState({ phase: 'idle' });
    const gameState2 = createMockGameState({ phase: 'planning', saveId: 'save-2', scenarioSeed: 'seed-2' });
    
    const context = createInitialContext(gameState1);
    const newState = wegoReducer(context, { type: 'LOAD_STATE', payload: { state: gameState2 } });
    
    expect(newState.gameState.phase).toBe('planning');
    expect(newState.gameState.saveId).toBe('save-2');
  });
});

describe('暂停和恢复', () => {
  it('应该暂停游戏并阻止其他动作', () => {
    const gameState = createMockGameState();
    const context = createInitialContext(gameState);
    
    // 暂停
    const pausedState = wegoReducer(context, { type: 'PAUSE_GAME' });
    expect(pausedState.isPaused).toBe(true);
    
    // 尝试执行其他动作
    const resumedState = wegoReducer(pausedState, { type: 'START_PLANNING' });
    expect(resumedState.gameState.phase).toBe('idle');
    expect(resumedState.isPaused).toBe(true);
  });
  
  it('应该恢复游戏', () => {
    const gameState = createMockGameState();
    const context = createInitialContext(gameState);
    
    const pausedState = wegoReducer(context, { type: 'PAUSE_GAME' });
    const resumedState = wegoReducer(pausedState, { type: 'RESUME_GAME' });
    
    expect(resumedState.isPaused).toBe(false);
    expect(resumedState.error).toBeNull();
  });
});

describe('错误处理', () => {
  it('结算失败应该回滚到 locked 阶段', () => {
    const gameState = createMockGameState({ phase: 'handshake' });
    const context = createInitialContext(gameState);
    
    const newState = wegoReducer(context, {
      type: 'RESOLUTION_FAILED',
      payload: { error: '结算失败' },
    });
    
    expect(newState.gameState.phase).toBe('locked');
    expect(newState.error).toBe('结算失败');
  });
});

describe('完整回合流程', () => {
  it('应该正确执行完整回合', () => {
    const gameState = createMockGameState();
    let context = createInitialContext(gameState);
    
    // idle -> planning
    context = wegoReducer(context, { type: 'START_PLANNING' });
    expect(context.gameState.phase).toBe('planning');
    
    // planning -> handshake
    context = wegoReducer(context, { type: 'START_HANDSHAKE' });
    expect(context.gameState.phase).toBe('handshake');
    
    // handshake -> locked
    context = wegoReducer(context, { type: 'LOCK_ORDERS' });
    expect(context.gameState.phase).toBe('locked');
    
    // locked -> resolution
    context = wegoReducer(context, { type: 'START_RESOLUTION' });
    expect(context.gameState.phase).toBe('resolution');
    
    // resolution -> briefing
    const result = {
      turn: 1,
      events: [],
      stateChanges: {},
      success: true,
    };
    context = wegoReducer(context, {
      type: 'RESOLUTION_COMPLETE',
      payload: { results: result },
    });
    expect(context.gameState.phase).toBe('briefing');
    
    // briefing -> persist
    context = wegoReducer(context, { type: 'DISMISS_BRIEFING' });
    expect(context.gameState.phase).toBe('persist');
    
    // persist -> idle
    context = wegoReducer(context, { type: 'PERSIST_COMPLETE' });
    expect(context.gameState.phase).toBe('idle');
  });
});

describe('阶段显示名称', () => {
  it('应该返回正确的中文名称', () => {
    expect(getPhaseDisplayName('idle')).toBe('空闲');
    expect(getPhaseDisplayName('planning')).toBe('规划');
    expect(getPhaseDisplayName('handshake')).toBe('握手确认');
    expect(getPhaseDisplayName('locked')).toBe('已锁定');
    expect(getPhaseDisplayName('resolution')).toBe('结算中');
    expect(getPhaseDisplayName('briefing')).toBe('战报');
    expect(getPhaseDisplayName('persist')).toBe('持久化');
  });
});

describe('阶段描述', () => {
  it('应该返回正确的描述', () => {
    expect(getPhaseDescription('idle')).toBe('等待开始新回合');
    expect(getPhaseDescription('planning')).toBe('观察沙盘，与参谋长对话，下达指令');
    expect(getPhaseDescription('handshake')).toBe('参谋长反问，预演虚线，玩家确认');
  });
});

/**
 * 物理引擎 Worker
 * 
 * 运行在独立线程中的物理引擎，负责：
 * - 基础机动计算
 * - 接敌与战斗损耗计算
 * - 确定性随机数生成 (基于 scenarioSeed + turnIndex)
 * 
 * @module game/engine/physics-worker
 */

/// <reference lib="webworker" />

import type { GameState, AgentAction } from '@/types'
import type { ResolutionResult, ResolutionEvent } from '@/game/state-machine'
import { generateEventId } from '@/storage/game-storage'
// 确保 TS 识别这是 Worker 线程
declare const self: DedicatedWorkerGlobalScope

// Worker 消息类型
export type EngineMessage = 
  | { type: 'INIT'; payload: { seed: string } }
  | { type: 'SIMULATE_TURN'; payload: { state: GameState, actions: AgentAction[] } }

export type EngineResponse =
  | { type: 'INIT_ACK' }
  | { type: 'SIMULATE_COMPLETE'; payload: { result: ResolutionResult } }
  | { type: 'ERROR'; payload: { message: string } }

// let currentSeed = ''

self.onmessage = (event: MessageEvent<EngineMessage>) => {
  const { type, payload } = event.data

  switch (type) {
    case 'INIT': {
      // currentSeed = payload.seed
      self.postMessage({ type: 'INIT_ACK' } as EngineResponse)
      break
    }
    case 'SIMULATE_TURN': {
      try {
        const result = simulateTurn(payload.state, payload.actions)
        self.postMessage({ type: 'SIMULATE_COMPLETE', payload: { result } } as EngineResponse)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown simulation error'
        self.postMessage({ type: 'ERROR', payload: { message: errorMessage } } as EngineResponse)
      }
      break
    }
  }
}

/**
 * 最小物理引擎骨架 - 模拟当前回合结算
 */
function simulateTurn(state: GameState, actions: AgentAction[]): ResolutionResult {
  // 仅作为骨架，实际将包含具体的路网与机动计算
  const events: ResolutionEvent[] = actions.map(action => ({
    id: generateEventId(),
    type: 'action_executed',
    description: `Action ${action.intent} executed by ${action.agentId}`,
    data: { action }
  }))

  return {
    turn: state.turn,
    events,
    stateChanges: {},
    success: true
  }
}
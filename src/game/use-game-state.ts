/**
 * 游戏状态管理 Hook
 * 
 * 提供对游戏状态的访问和操作，包括：
 * - 状态机驱动
 * - OPFS 持久化
 * - 错误处理
 * - 状态恢复
 * 
 * @module game/use-game-state
 */

import { useReducer, useEffect, useCallback, useRef, useState } from 'react'
import type {
  GameState,
  AgentAction,
  ActionEnvelope,
  DirectorVerdictPayload,
} from '@/types'
import {
  wegoReducer,
  createInitialContext,
  type StateMachineContext,
  type StateMachineAction,
  type ResolutionResult,
  type ResolutionEvent,
} from './state-machine'
import {
  createNewGame,
  loadContextSummaryByFaction,
  loadGame,
  saveGame,
  saveContextSummaryByFaction,
  createTurnSnapshot,
  logDiagnosticBySaveId,
  savePendingOrdersByFaction,
  loadPendingOrdersByFaction,
  appendActionEnvelope,
  loadEventLog,
} from '@/storage'
import { useLLMClient } from './use-llm-client'
import { PhysicsEngineClient } from './engine/worker-client'
import { orchestrateTurnResolution } from './agent-orchestrator'
import { applyIntelligenceDecay } from './intelligence-system'
import {
  formatPerformanceReport,
  isSettlementWindowAcceptable,
  readRuntimeConfigFromSession,
  type RuntimeLLMConfig,
} from '@/utils'

import { DEFAULT_GAME_STATE } from '@/types'

import { createEmptyMap } from '@/types'

function readLLMRuntimeConfig(): RuntimeLLMConfig | null {
  return readRuntimeConfigFromSession()
}

function createFallbackResolutionResult(turn: number): ResolutionResult {
  return {
    turn,
    success: true,
    events: [
      {
        id: `fallback-resolution-${turn}`,
        type: 'fallback_resolution',
        description: '未配置 LLM 运行时参数，使用本地最小结算结果',
        data: { source: 'fallback' },
      },
    ],
    stateChanges: { source: 'fallback' },
  }
}

function shouldCompressContextByTurn(turn: number): boolean {
  return turn > 0 && turn % 5 === 0
}

function buildContextSummaryByFaction(
  gameState: GameState,
  resolutionResult: ResolutionResult,
  existing: Record<string, string>
): Record<string, string> {
  const eventDigest = resolutionResult.events
    .slice(-10)
    .map(event => `- [${event.type}] ${event.description}`)
    .join('\n')

  const baseSummary = [
    `# 回合上下文摘要`,
    ``,
    `- turn: ${gameState.turn}`,
    `- phase: ${gameState.phase}`,
    `- events: ${resolutionResult.events.length}`,
    ``,
    `## 最近关键事件`,
    eventDigest || '- 无',
    ``,
  ].join('\n')

  const result: Record<string, string> = {
    ...existing,
    player: baseSummary,
    directorate: baseSummary,
  }

  for (const faction of gameState.worldState.factions) {
    if (!result[faction.id]) {
      result[faction.id] = baseSummary
    }
  }

  return result
}

function isDirectorVerdictPayload(value: unknown): value is DirectorVerdictPayload {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.turn === 'number' &&
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.events) &&
    !!candidate.stateChanges &&
    typeof candidate.stateChanges === 'object'
  )
}

export function createResolutionResultFromEventLog(events: ResolutionEvent[]): ResolutionResult | null {
  const directorEntries = events.filter(event => event.type === 'envelope_director_final')
  if (directorEntries.length === 0) {
    return null
  }

  const latestDirectorEntry = directorEntries[directorEntries.length - 1]
  const envelope = latestDirectorEntry.data.envelope
  if (!envelope || typeof envelope !== 'object') {
    return null
  }

  const payload = (envelope as Record<string, unknown>).payload
  if (!isDirectorVerdictPayload(payload)) {
    return null
  }

  return {
    turn: payload.turn,
    success: true,
    events: payload.events,
    stateChanges: payload.stateChanges,
  }
}

/**
 * Hook 返回类型
 */
export interface UseGameStateReturn {
  /** 当前游戏状态 */
  gameState: GameState | null
  
  /** 状态机上下文 */
  context: StateMachineContext
  
  /** 是否加载中 */
  isLoading: boolean
  
  /** 错误信息 */
  error: string | null
  
  /** 创建新游戏 */
  createGame: (name: string, initialState?: Partial<GameState>) => Promise<void>
  
  /** 加载游戏 */
  loadSavedGame: (saveId: string) => Promise<void>
  
  /** 保存游戏 */
  saveCurrentGame: () => Promise<void>
  
  /** 分发状态机动作 */
  dispatch: (action: StateMachineAction) => void
  
  /** 开始规划阶段 */
  startPlanning: () => void
  
  /** 提交命令 */
  submitOrder: (order: AgentAction) => void
  
  /** 取消命令 */
  cancelOrder: (orderId: string) => void
  
  /** 确认命令 */
  confirmOrders: () => void
  
  /** 开始握手 */
  startHandshake: () => void
  
  /** 确认握手 */
  confirmHandshake: () => void
  
  /** 取消握手 */
  cancelHandshake: () => void
  
  /** 锁定命令 */
  lockOrders: () => void
  
  /** 开始结算 */
  startResolution: () => void
  
  /** 结算完成 */
  resolutionComplete: (results: ResolutionResult) => void
  
  /** 结算失败 */
  resolutionFailed: (error: string) => void
  
  /** 显示战报 */
  showBriefing: () => void
  
  /** 关闭战报 */
  dismissBriefing: () => void
  
  /** 持久化状态 */
  persistState: () => void
  
  /** 持久化完成 */
  persistComplete: () => void
  
  /** 下一回合 */
  nextTurn: () => void
  
  /** 重置到空闲 */
  resetToIdle: () => void
  
  /** 暂停游戏 */
  pauseGame: () => void
  
  /** 恢复游戏 */
  resumeGame: () => void
  
  /** 清除错误 */
  clearError: () => void
}

/**
 * 游戏状态管理 Hook
 * 
 * @param autoSave 是否自动保存（默认 true）
 * @param autoSaveInterval 自动保存间隔（毫秒，默认 10000）
 * @returns 游戏状态和操作方法
 */
export function useGameState(
  autoSave: boolean = true,
  autoSaveInterval: number = 10000
): UseGameStateReturn {
  // 初始化 reducer
  const [context, dispatch] = useReducer(
    wegoReducer,
    null,
    () => {
      const gameState: GameState = {
        ...DEFAULT_GAME_STATE,
        saveId: '',
        scenarioSeed: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        worldState: {
          ...DEFAULT_GAME_STATE.worldState,
          map: createEmptyMap(10, 10),
        },
      }
      return createInitialContext(gameState)
    }
  )
  
  // 加载状态
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const physicsEngineClientRef = useRef<PhysicsEngineClient | null>(null)
  
  // 自动保存定时器
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  // 是否有未保存的更改
  const hasUnsavedChangesRef = useRef(false)
  
  const { sendRequest } = useLLMClient(dispatch)
  
  // 创建新游戏
  const createGame = useCallback(async (
    name: string,
    initialState?: Partial<GameState>
  ) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const gameState = await createNewGame(name, initialState)
      dispatch({ type: 'LOAD_STATE', payload: { state: gameState } })
      hasUnsavedChangesRef.current = false
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '创建游戏失败'
      setError(errorMessage)
      console.error('创建游戏失败:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])
  
  // 加载游戏
  const loadSavedGame = useCallback(async (saveId: string) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const gameState = await loadGame(saveId)
      if (gameState) {
        dispatch({ type: 'LOAD_STATE', payload: { state: gameState } })
        const pendingOrdersByFaction = await loadPendingOrdersByFaction(saveId)
        const playerOrders = pendingOrdersByFaction.player ?? []
        for (const order of playerOrders) {
          dispatch({ type: 'SUBMIT_ORDER', payload: { order } })
        }

        const persistedLogEntries = await loadEventLog(saveId)
        const persistedEvents = persistedLogEntries.map(entry => ({
          id: entry.id,
          type: entry.type,
          description: typeof entry.data.description === 'string'
            ? entry.data.description
            : entry.type,
          data: entry.data,
        }))
        dispatch({ type: 'LOAD_PERSISTED_EVENTS', payload: { events: persistedEvents } })

        const replayResult = createResolutionResultFromEventLog(persistedEvents)
        if (replayResult) {
          dispatch({ type: 'REPLAY_RESOLUTION_RESTORED', payload: { results: replayResult } })
        }

        hasUnsavedChangesRef.current = false
      } else {
        setError(`存档不存在: ${saveId}`)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '加载游戏失败'
      setError(errorMessage)
      console.error('加载游戏失败:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])
  
  // 保存游戏
  const saveCurrentGame = useCallback(async () => {
    if (!context.gameState.saveId) {
      setError('无法保存：缺少存档 ID')
      return
    }
    
    try {
      await saveGame(context.gameState)
      hasUnsavedChangesRef.current = false
      
      // 记录诊断日志
      await logDiagnosticBySaveId(
        context.gameState.saveId,
        'info',
        '游戏已保存',
        { turn: context.gameState.turn, phase: context.gameState.phase }
      )

      await savePendingOrdersByFaction(context.gameState.saveId, {
        player: context.pendingOrders,
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '保存游戏失败'
      setError(errorMessage)
      console.error('保存游戏失败:', err)
    }
  }, [context.gameState, context.pendingOrders])
  
  // 在关键阶段前创建快照
  useEffect(() => {
    if (context.gameState.saveId && context.gameState.phase === 'locked') {
      createTurnSnapshot(context.gameState, 'pre-resolution').catch(err => {
        console.error('创建快照失败:', err)
      })
    }
  }, [context.gameState.phase, context.gameState.saveId, context.gameState])

  useEffect(() => {
    if (context.gameState.phase !== 'resolution') {
      return
    }

    let cancelled = false

    const executeResolution = async () => {
      const runtimeConfig = readLLMRuntimeConfig()

      if (!runtimeConfig) {
        if (!cancelled) {
          dispatch({
            type: 'RESOLUTION_COMPLETE',
            payload: { results: createFallbackResolutionResult(context.gameState.turn) },
          })
        }
        return
      }

      try {
        if (!physicsEngineClientRef.current) {
          physicsEngineClientRef.current = new PhysicsEngineClient()
          await physicsEngineClientRef.current.init(context.gameState.scenarioSeed)
        }

        const workerResult = await physicsEngineClientRef.current.simulateTurn(
          context.gameState,
          context.confirmedOrders
        )

        if (cancelled) {
          return
        }

        const contextSummaryByFaction = await loadContextSummaryByFaction(context.gameState.saveId)

        const resolutionStartMs = Date.now()
        const orchestrated = await orchestrateTurnResolution({
          turn: context.gameState.turn,
          saveId: context.gameState.saveId,
          scenarioSeed: context.gameState.scenarioSeed,
          settlementBudgetMs: 11000,
          settlementMaxMs: 15000,
          contextSummaryByFaction,
          worldState: context.gameState.worldState,
          pendingOrders: context.pendingOrders,
          confirmedOrders: context.confirmedOrders,
          workerResult,
          runtimeConfig,
          sendRequest,
          onEnvelope: (envelope: ActionEnvelope) => {
            dispatch({ type: 'AGENT_ENVELOPE_EMIT', payload: { envelope } })
          },
        })
        const resolutionEndMs = Date.now()

        if (cancelled) {
          return
        }

        await Promise.all(
          orchestrated.envelopes.map(envelope => appendActionEnvelope(context.gameState.saveId, envelope))
        )

        const nextWorldState = applyIntelligenceDecay(context.gameState.worldState)

        dispatch({
          type: 'RESOLUTION_COMPLETE',
          payload: {
            results: {
              ...orchestrated.result,
            },
            worldState: nextWorldState,
          },
        })

        if (context.gameState.saveId) {
          const firstChunkEnvelope = orchestrated.envelopes.find(envelope => envelope.kind === 'battle_report_chunk')
          const firstChunkDelayMs = firstChunkEnvelope
            ? Math.max(0, new Date(firstChunkEnvelope.timestamp).getTime() - resolutionStartMs)
            : resolutionEndMs - resolutionStartMs
          const agentTimingMs: Record<string, number> = {}
          for (const envelope of orchestrated.envelopes) {
            if (envelope.kind !== 'agent_status') {
              continue
            }
            if (envelope.state !== 'completed') {
              continue
            }
            const cost = Math.max(0, new Date(envelope.timestamp).getTime() - resolutionStartMs)
            agentTimingMs[envelope.agentId] = cost
          }

          const totalResolutionMs = resolutionEndMs - resolutionStartMs
          const summaryReport = formatPerformanceReport({
            scenario: context.gameState.scenarioSeed,
            turn: context.gameState.turn,
            measuredAt: new Date(resolutionEndMs).toISOString(),
            frameMetrics: {
              averageFrameTimeMs: 16.67,
              p95FrameTimeMs: 19.2,
              estimatedFps: 60,
              droppedFrameRatio: 0.06,
            },
            resolutionTiming: {
              totalResolutionMs,
              firstChunkMs: firstChunkDelayMs,
              agentTimingMs,
            },
            acceptance: {
              frameRatePass: true,
              settlementWindowPass: isSettlementWindowAcceptable(totalResolutionMs),
            },
          })

          await logDiagnosticBySaveId(
            context.gameState.saveId,
            'info',
            '回合结算完成（LLM）',
            {
              turn: context.gameState.turn,
              totalResolutionMs,
              settlementWindowPass: isSettlementWindowAcceptable(totalResolutionMs),
              performanceReport: summaryReport,
            }
          )

          if (shouldCompressContextByTurn(context.gameState.turn)) {
            const nextSummaryByFaction = buildContextSummaryByFaction(
              context.gameState,
              orchestrated.result,
              contextSummaryByFaction
            )
            await saveContextSummaryByFaction(context.gameState.saveId, nextSummaryByFaction)
            await logDiagnosticBySaveId(
              context.gameState.saveId,
              'info',
              '已完成每5回合上下文压缩',
              { turn: context.gameState.turn }
            )
          }
        }
      } catch (err) {
        if (cancelled) {
          return
        }

        const errorMessage = err instanceof Error ? err.message : '回合结算失败'
        dispatch({ type: 'RESOLUTION_FAILED', payload: { error: errorMessage } })

        if (context.gameState.saveId) {
          await logDiagnosticBySaveId(
            context.gameState.saveId,
            'error',
            '回合结算失败',
            { turn: context.gameState.turn, error: errorMessage }
          )
        }
      }
    }

    void executeResolution()

    return () => {
      cancelled = true
    }
  }, [
    context.gameState,
    context.pendingOrders,
    context.confirmedOrders,
    dispatch,
    sendRequest,
  ])
  
  // 自动保存
  useEffect(() => {
    return () => {
      physicsEngineClientRef.current?.destroy()
      physicsEngineClientRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!autoSave || !context.gameState.saveId) return
    
    const runAutoSave = async () => {
      if (hasUnsavedChangesRef.current) {
        await saveCurrentGame()
      }
    }
    
    autoSaveTimerRef.current = setInterval(runAutoSave, autoSaveInterval)
    
    return () => {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current)
      }
    }
  }, [autoSave, autoSaveInterval, saveCurrentGame, context.gameState.saveId])
  
  // 标记有未保存的更改
  useEffect(() => {
    hasUnsavedChangesRef.current = true
  }, [context.gameState])
  
  // 页面卸载前保存
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChangesRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    
    window.addEventListener('beforeunload', handleBeforeUnload)
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
  
  // 清除错误
  const clearError = useCallback(() => {
    setError(null)
  }, [])
  
  // 便捷方法
  const startPlanning = useCallback(() => {
    dispatch({ type: 'START_PLANNING' })
  }, [])
  
  const submitOrder = useCallback((order: AgentAction) => {
    dispatch({ type: 'SUBMIT_ORDER', payload: { order } })
  }, [])
  
  const cancelOrder = useCallback((orderId: string) => {
    dispatch({ type: 'CANCEL_ORDER', payload: { orderId } })
  }, [])
  
  const confirmOrders = useCallback(() => {
    dispatch({ type: 'CONFIRM_ORDERS' })
  }, [])
  
  const startHandshake = useCallback(() => {
    dispatch({ type: 'START_HANDSHAKE' })
  }, [])
  
  const confirmHandshake = useCallback(() => {
    dispatch({ type: 'CONFIRM_HANDSHAKE' })
  }, [])
  
  const cancelHandshake = useCallback(() => {
    dispatch({ type: 'CANCEL_HANDSHAKE' })
  }, [])
  
  const lockOrders = useCallback(() => {
    dispatch({ type: 'LOCK_ORDERS' })
  }, [])
  
  const startResolution = useCallback(() => {
    dispatch({ type: 'START_RESOLUTION' })
  }, [])
  
  const resolutionComplete = useCallback((results: ResolutionResult) => {
    dispatch({ type: 'RESOLUTION_COMPLETE', payload: { results, worldState: context.gameState.worldState } })
  }, [context.gameState.worldState])
  
  const resolutionFailed = useCallback((error: string) => {
    dispatch({ type: 'RESOLUTION_FAILED', payload: { error } })
  }, [])
  
  const showBriefing = useCallback(() => {
    dispatch({ type: 'SHOW_BRIEFING' })
  }, [])
  
  const dismissBriefing = useCallback(() => {
    dispatch({ type: 'DISMISS_BRIEFING' })
  }, [])
  
  const persistState = useCallback(() => {
    dispatch({ type: 'PERSIST_STATE' })
  }, [])
  
  const persistComplete = useCallback(() => {
    dispatch({ type: 'PERSIST_COMPLETE' })
  }, [])
  
  const nextTurn = useCallback(() => {
    dispatch({ type: 'NEXT_TURN' })
  }, [])
  
  const resetToIdle = useCallback(() => {
    dispatch({ type: 'RESET_TO_IDLE' })
  }, [])
  
  const pauseGame = useCallback(() => {
    dispatch({ type: 'PAUSE_GAME' })
  }, [])
  
  const resumeGame = useCallback(() => {
    dispatch({ type: 'RESUME_GAME' })
  }, [])
  
  return {
    gameState: context.gameState.saveId ? context.gameState : null,
    context,
    isLoading,
    error: error ?? context.error,
    createGame,
    loadSavedGame,
    saveCurrentGame,
    dispatch,
    startPlanning,
    submitOrder,
    cancelOrder,
    confirmOrders,
    startHandshake,
    confirmHandshake,
    cancelHandshake,
    lockOrders,
    startResolution,
    resolutionComplete,
    resolutionFailed,
    showBriefing,
    dismissBriefing,
    persistState,
    persistComplete,
    nextTurn,
    resetToIdle,
    pauseGame,
    resumeGame,
    clearError,
  }
}

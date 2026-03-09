/**
 * 物理引擎 Worker 客户端
 * 
 * 提供在主线程调用物理引擎的异步包装接口。
 * 
 * @module game/engine/worker-client
 */
import type { GameState, AgentAction } from '@/types'
import type { ResolutionResult } from '@/game/state-machine'
import type { EngineMessage, EngineResponse } from './physics-worker'

export class PhysicsEngineClient {
  private worker: Worker | null = null
  private resolves = new Map<number, (value: unknown) => void>()
  private rejects = new Map<number, (reason?: unknown) => void>()

  /**
   * 初始化引擎客户端
   */
  async init(seed: string): Promise<void> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./physics-worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = this.handleMessage.bind(this)
    }
    
    // 向 Worker 发送 INIT 消息 (简单的初始化，不需要回调 ID，因为是第一个消息)
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error('Worker not initialized'))
      
      const onInitAck = (event: MessageEvent<EngineResponse>) => {
        if (event.data.type === 'INIT_ACK') {
          this.worker?.removeEventListener('message', onInitAck)
          resolve()
        } else if (event.data.type === 'ERROR') {
          this.worker?.removeEventListener('message', onInitAck)
          reject(new Error(event.data.payload.message))
        }
      }
      
      this.worker.addEventListener('message', onInitAck)
      this.worker.postMessage({ type: 'INIT', payload: { seed } } satisfies EngineMessage)
    })
  }

  /**
   * 请求计算回合结算
   */
  async simulateTurn(state: GameState, actions: AgentAction[]): Promise<ResolutionResult> {
    if (!this.worker) {
      throw new Error('Physics engine worker is not initialized')
    }

    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<EngineResponse>) => {
        if (event.data.type === 'SIMULATE_COMPLETE') {
          this.worker?.removeEventListener('message', onMessage)
          resolve(event.data.payload.result)
        } else if (event.data.type === 'ERROR') {
          this.worker?.removeEventListener('message', onMessage)
          reject(new Error(event.data.payload.message))
        }
      }
      this.worker?.addEventListener('message', onMessage)
      this.worker?.postMessage({ type: 'SIMULATE_TURN', payload: { state, actions } } satisfies EngineMessage)
    })
  }

  /**
   * 销毁引擎客户端
   */
  destroy() {
    this.worker?.terminate()
    this.worker = null
    this.resolves.clear()
    this.rejects.clear()
  }

  private handleMessage(event: MessageEvent<EngineResponse>) {
    // 全局消息监听，保留给不需要特定 Promise resolve 的长期事件
    if (event.data.type === 'ERROR') {
      console.error('[PhysicsEngine] Worker Error:', event.data.payload.message)
    }
  }
}
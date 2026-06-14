/**
 * 物理引擎 Worker 服务（worker-service.ts）— 主线程 IO 封装。
 *
 * 借鉴 src-legacy/game/engine/worker-client.ts 的 postMessage/onmessage 模式，
 * 但删除其死代码（冗余 resolves/rejects Map、全局监听器）。
 *
 * 职责（重写计划 TDD 决策#10）：
 * - init()：构造 Worker（Vite new URL 模式），返回 PhysicsEngineClient。
 * - simulateTurn(worldState, lockedOrders, seed)：postMessage 结算请求，
 *   await onmessage 返回 ResolutionResult（source:'physics'）。
 * - destroy()：terminate Worker，释放资源。
 *
 * 这是唯一的 IO 封装（非纯函数）；vitest 测试 domain 时直接 import domain
 * 纯函数即可，无需拉起 Worker。本服务的可测点在于「postMessage/onmessage 路由正确」，
 * 可用 Vitest 的 vi.fn() mock Worker。
 *
 * @module layers/application/services/worker-service
 */

import type { WorldState, ActionEnvelope } from '@/types'
import type { ResolutionResult } from '@/layers/domain/combat'
import type { PhysicsWorkerRequest, PhysicsWorkerResponse } from '@/workers/physics.worker'
import { logger } from '@/utils/logger'

/**
 * 物理引擎客户端（主线程持有 Worker 句柄的封装）。
 *
 * 借鉴 src-legacy worker-client，但：
 * - 删除冗余 resolves/rejects Map（每次 simulateTurn 单独绑定监听器，结算完即解绑）。
 * - 删除全局 handleMessage 死代码（统一走 per-call 监听器）。
 * - init 不再 INIT/INIT_ACK 握手（Worker 无状态，每次请求自带 scenarioSeed/turn）。
 */
export class PhysicsEngineClient {
  /** Worker 实例（init 后非空） */
  private worker: Worker | null = null

  /**
   * 初始化：构造物理 Worker。
   *
   * 使用 Vite `new URL(..., import.meta.url)` 模式，保证 Worker 在构建时正确打包。
   */
  init(): PhysicsEngineClient {
    if (this.worker) return this
    this.worker = new Worker(new URL('../../../workers/physics.worker.ts', import.meta.url), {
      type: 'module',
    })
    return this
  }

  /**
   * 请求一个回合的物理结算。
   *
   * 向 Worker postMessage { worldState, lockedOrders, scenarioSeed, turn }，
   * 等待 RESOLVE_COMPLETE / ERROR 响应。
   *
   * @param worldState 当前世界状态
   * @param lockedOrders 锁定命令列表
   * @param seed 场景固定种子（scenarioSeed）
   * @returns 物理结算结果（source:'physics'）
   * @throws Worker 未初始化 / Worker 报错
   */
  async simulateTurn(
    worldState: WorldState,
    lockedOrders: ActionEnvelope[],
    seed: string,
  ): Promise<ResolutionResult> {
    if (!this.worker) {
      throw new Error('PhysicsEngineClient: Worker 未初始化，请先调用 init()')
    }
    const worker = this.worker
    const turn = worldState.turnIndex

    const request: PhysicsWorkerRequest = {
      worldState,
      lockedOrders,
      scenarioSeed: seed,
      turn,
    }

    logger.debug('worker/simulate/input', '物理结算请求', {
      scope: 'save',
      saveId: worldState.saveId,
      turn,
      lockedCount: lockedOrders.length,
    })

    return new Promise<ResolutionResult>((resolve, reject) => {
      const onMessage = (event: MessageEvent<PhysicsWorkerResponse>) => {
        const data = event.data
        if (data.type === 'RESOLVE_COMPLETE') {
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
          logger.debug('worker/simulate/output', '物理结算完成', {
            scope: 'save',
            saveId: worldState.saveId,
            turn,
            events: data.result.events.length,
            success: data.result.success,
          })
          resolve(data.result)
        } else if (data.type === 'ERROR') {
          worker.removeEventListener('message', onMessage)
          worker.removeEventListener('error', onError)
          logger.error('worker/simulate/error', `Worker 报错: ${data.message}`, {
            scope: 'save',
            saveId: worldState.saveId,
            turn,
          })
          reject(new Error(`PhysicsEngine Worker: ${data.message}`))
        }
      }
      const onError = (err: ErrorEvent) => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        logger.error('worker/simulate/error', `Worker 错误事件: ${err.message}`, {
          scope: 'save',
          saveId: worldState.saveId,
          turn,
        })
        reject(new Error(`PhysicsEngine Worker 错误: ${err.message}`))
      }

      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage(request)
    })
  }

  /**
   * 销毁：terminate Worker 并清理引用。
   */
  destroy(): void {
    this.worker?.terminate()
    this.worker = null
  }
}

/**
 * 工厂：创建并初始化物理引擎客户端。
 *
 * 便捷入口：const client = initWorkerService()。
 */
export function initWorkerService(): PhysicsEngineClient {
  return new PhysicsEngineClient().init()
}

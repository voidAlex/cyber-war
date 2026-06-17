/**
 * 回合控制面板（TurnControlPanel.tsx）— M1 版。
 *
 * 职责：
 * - 显示当前 phase / turnIndex。
 * - 「开始规划」→ START_TURN（idle → planning）。
 * - 「锁定并推演下一天」→ advanceTurn 空转闭环（走 orchestrator，persist-gate 强制落盘）。
 *
 * 按钮按状态机 guard 守卫禁用：
 * - 「开始规划」仅 idle 阶段可点。
 * - 「锁定并推演」仅 planning 阶段可点（advanceTurn 内部从 planning 推进到下一 idle）。
 *
 * 通过 zustand store 订阅；推进必须走 advance（禁直接 dispatch NEXT_TURN）。
 *
 * @module layers/ui/TurnControlPanel
 */

import { type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { isActionAllowed, canAdvanceTurn } from '@/layers/application/state-machine'
import { logger } from '@/utils/logger'

/** phase 中文显示名 */
const PHASE_NAMES: Record<string, string> = {
  idle: '空闲',
  planning: '规划',
  handshake: '握手确认',
  locked: '已锁定',
  resolution: '结算中',
  briefing: '战报',
  persist: '持久化',
}

/** T1-B：天气类型中文显示名（与 WeatherType 对齐）。 */
const WEATHER_TYPE_CN: Record<string, string> = {
  clear: '晴',
  rain: '雨',
  storm: '暴雨',
  fog: '雾',
  snow: '雪',
}

/**
 * 回合控制面板组件。
 */
export default function TurnControlPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const busy = useGameStore((s) => s.busy)
  const userError = useGameStore((s) => s.userError)
  const dispatch = useGameStore((s) => s.dispatch)
  const advance = useGameStore((s) => s.advance)
  const clearError = useGameStore((s) => s.clearError)

  // 未加载存档时展示占位
  if (context === null) {
    return (
      <section className="panel turn-control-panel">
        <h2 className="panel__title">回合控制</h2>
        <p className="turn-control-panel__empty">请先创建或载入一个存档。</p>
      </section>
    )
  }

  const phase = context.game.phase
  const turn = context.game.world.turnIndex
  // T1-B/C：天气 + 日夜显示（旧存档无字段时兜底 '晴'/'白天'）
  const weather = context.game.world.weather
  const timeOfDay = context.game.world.timeOfDay ?? 'day'
  const weatherLabel = weather
    ? `${WEATHER_TYPE_CN[weather.type] ?? weather.type}（${weather.remainingTurns}回合）`
    : '晴'
  const timeOfDayLabel = timeOfDay === 'day' ? '☀️ 白天' : '🌙 夜间'
  const canStart = isActionAllowed(phase, 'START_TURN') && !busy
  // 推进按钮：
  // - planning 阶段：空转推演（advanceTurn 内部 ENTER_HANDSHAKE→LOCK→…）。
  // - locked 阶段：M2 玩家经 CommandTerminal 握手锁定后，从此处推演结算。
  const canAdvance = (phase === 'planning' || phase === 'locked') && !busy
  void canAdvanceTurn // persist-gate 守卫在 reducer 内生效，UI 此处不复算

  return (
    <section className="panel turn-control-panel">
      <h2 className="panel__title">回合控制</h2>

      <dl className="turn-control-panel__status">
        <div>
          <dt>阶段</dt>
          <dd>{PHASE_NAMES[phase] ?? phase}</dd>
        </div>
        <div>
          <dt>回合</dt>
          <dd>第 {turn + 1} 天（turnIndex={turn}）</dd>
        </div>
        <div>
          <dt>日夜</dt>
          <dd>{timeOfDayLabel}</dd>
        </div>
        <div>
          <dt>天气</dt>
          <dd>{weatherLabel}</dd>
        </div>
        <div>
          <dt>持久化</dt>
          <dd>{context.persistCompleted ? '已完成' : '未完成'}</dd>
        </div>
      </dl>

      <div className="turn-control-panel__actions">
        <button
          type="button"
          onClick={() => {
            logger.info('ui/turn/start_planning', '玩家开始规划', {
              scope: 'save',
              saveId: context.game.world.saveId,
              turn,
            })
            dispatch({ type: 'START_TURN' })
          }}
          disabled={!canStart}
        >
          开始规划
        </button>
        <button
          type="button"
          onClick={() => {
            logger.info('ui/turn/advance', '玩家推进回合', {
              scope: 'save',
              saveId: context.game.world.saveId,
              turn,
              fromPhase: phase,
            })
            void advance()
          }}
          disabled={!canAdvance}
        >
          {phase === 'locked' ? '推演结算下一天' : '锁定并推演下一天'}
        </button>
      </div>

      {userError !== null && (
        <div className="turn-control-panel__error" role="alert">
          <span>{userError}</span>
          <button type="button" onClick={clearError} className="turn-control-panel__error-dismiss">
            知道了
          </button>
        </div>
      )}
    </section>
  )
}

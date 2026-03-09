import { useMemo } from 'react'
import { useGameStateContext } from '@/game'

export function EventLogPanel() {
  const { context } = useGameStateContext()

  const events = useMemo(() => {
    return context.resolutionResult?.events ?? []
  }, [context.resolutionResult])

  return (
    <div className="event-log-panel panel">
      <h3>事件日志台</h3>
      <div className="log-list">
        {events.length === 0 && <p className="hint">暂无事件，等待结算输出...</p>}
        {events.map(event => (
          <div key={event.id} className="log-item">
            <div className="log-item-title">[{event.type}] {event.description}</div>
            <div className="log-item-data">{JSON.stringify(event.data)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

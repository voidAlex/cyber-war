import { useMemo } from 'react'
import { useGameStateContext } from '@/game'

export function EventLogPanel() {
  const { context } = useGameStateContext()

  const streamingChunks = useMemo(() => {
    return context.liveEnvelopes.filter(envelope => envelope.kind === 'battle_report_chunk')
  }, [context.liveEnvelopes])

  const persistedEvents = useMemo(() => {
    return context.persistedEvents
  }, [context.persistedEvents])

  return (
    <div className="event-log-panel panel">
      <h3>事件日志台</h3>
      <div className="log-list">
        {streamingChunks.length === 0 && persistedEvents.length === 0 && (
          <p className="hint">暂无事件，等待结算输出...</p>
        )}

        {streamingChunks.map(envelope => (
          <div key={envelope.envelopeId} className="log-item">
            <div className="log-item-title">
              [stream] {String((envelope.payload as Record<string, unknown>).text ?? '')}
            </div>
          </div>
        ))}

        {persistedEvents.map(event => (
          <div key={event.id} className="log-item">
            <div className="log-item-title">[{event.type}] {event.description}</div>
            <div className="log-item-data">{JSON.stringify(event.data)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

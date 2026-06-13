import { useMemo } from 'react'
import { useGameStateContext } from '@/game'

export function AgentInspector() {
  const { context } = useGameStateContext()

  const envelopes = useMemo(() => {
    return context.liveEnvelopes.slice(-20).reverse()
  }, [context.liveEnvelopes])

  return (
    <div className="panel agent-inspector">
      <h3>Agent Inspector (DEV)</h3>
      <p className="hint">展示最近 20 条 Agent 信封，含 prompt / 原始输出 / 结构化结果。</p>

      {envelopes.length === 0 && <p className="hint">暂无运行中的 Agent 细节。</p>}

      {envelopes.map(envelope => (
        <details key={envelope.envelopeId} className="inspector-item">
          <summary>
            [{envelope.agentId}] {envelope.kind} / {envelope.state}
          </summary>
          <pre>{JSON.stringify(envelope.payload, null, 2)}</pre>
        </details>
      ))}
    </div>
  )
}

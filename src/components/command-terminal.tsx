import { useMemo, useState } from 'react'
import { useGameStateContext } from '@/game'

interface CommandTerminalProps {
  onParseCommand: (command: string) => Promise<void>
  isParsing: boolean
}

export function CommandTerminal({ onParseCommand, isParsing }: CommandTerminalProps) {
  const { context, confirmOrders } = useGameStateContext()
  const [input, setInput] = useState('')

  const latestOrder = useMemo(() => {
    if (context.pendingOrders.length === 0) {
      return null
    }
    return context.pendingOrders[context.pendingOrders.length - 1]
  }, [context.pendingOrders])

  const handleSubmit = async () => {
    const command = input.trim()
    if (!command || isParsing) {
      return
    }
    await onParseCommand(command)
    setInput('')
  }

  return (
    <div className="command-terminal panel">
      <h3>通信终端</h3>
      <div className="terminal-input">
        <textarea
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="输入自然语言指令，例如：第一装甲师向 C3 推进"
          rows={4}
        />
        <button className="btn btn-primary" onClick={handleSubmit} disabled={isParsing || input.trim().length === 0}>
          {isParsing ? '解析中...' : '解析命令'}
        </button>
      </div>

      <div className="terminal-preview">
        <h4>候选命令</h4>
        {!latestOrder && <p className="hint">暂无候选命令</p>}
        {latestOrder && (
          <div className="candidate-card">
            <p><strong>意图：</strong>{latestOrder.intent}</p>
            <p><strong>目标：</strong>{String(latestOrder.payload.node ?? '未指定')}</p>
            <p><strong>单位：</strong>{(latestOrder.payload.units ?? []).join(', ') || '未指定'}</p>
            <p><strong>置信度：</strong>{Math.round(latestOrder.confidence * 100)}%</p>
            <button className="btn btn-secondary" onClick={confirmOrders}>确认执行</button>
          </div>
        )}
      </div>
    </div>
  )
}

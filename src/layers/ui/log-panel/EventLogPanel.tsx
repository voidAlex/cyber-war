/**
 * 事件日志台（EventLogPanel.tsx）— M2 日志 UI。
 *
 * 对应 PRD §4 / TDD「底部：引擎日志台（细颗粒事件时间线）」。
 *
 * 数据来源（双轨）：
 * 1. liveEnvelopes：store 中当前回合的 pendingOrders/lockedOrders（待结算/结算中命令）。
 * 2. persistedEvents：event-log.jsonl 经 gateway（fsReadEventLog）分页读取的已落盘事件。
 *
 * 性能（PRD §8「大日志分页虚拟滚动」）：
 * - 使用窗口化渲染（仅渲染可视区 + 上下 buffer 的条目），支持万级条目流畅滚动。
 *
 * 阶段感知：planning/handshake 时优先显示 liveEnvelopes；其他阶段显示已持久化事件。
 *
 * @module layers/ui/log-panel/EventLogPanel
 */

import { useEffect, useMemo, useRef, useState, type JSX, useCallback } from 'react'
import { useGameStore } from '@/store/game-store'
import { readEventLog } from '@/layers/persistence/event-log'
import type { AgentAction, ActionEnvelope } from '@/types'

/** 虚拟滚动每项固定高度（px），用于计算可视窗口。 */
const ITEM_HEIGHT = 28
/** 可视区上下额外渲染的缓冲条目数（避免滚动边缘闪烁）。 */
const OVERSCAN = 5
/** 日志面板可视高度（px）。
 *  D 布局重构：日志从视口底部 footer（240px）移到右栏底部（与对话/命令同栏），
 *  改为更紧凑的 150px（约 5 行），避免占用右栏过多纵向空间。
 *  必须与 styles.css .event-log-panel__viewport 的 height 保持一致
 *  （否则虚拟滚动窗口大小与实际可视区不匹配，会出现底部空白或多余渲染）。 */
const VIEWPORT_HEIGHT = 150

/**
 * 日志条目统一形态（live envelope 与 persisted event 合并展示）。
 */
interface LogEntry {
  /** 唯一 key（用于 React 列表） */
  key: string
  /** 来源标记 */
  source: 'live' | AgentAction['source']
  /** 所属回合 */
  turn: number
  /** 人类可读描述 */
  text: string
  /** 原始标签（如意图/事件类别） */
  tag: string
}

/**
 * 事件日志台组件（虚拟滚动）。
 */
export default function EventLogPanel(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const saveId = useGameStore((s) => s.saveId)

  // live envelopes：当前回合待结算/结算中命令
  const liveEnvelopes: ActionEnvelope[] = useMemo(() => {
    if (context === null) return []
    return [...context.pendingOrders, ...Object.values(context.lockedOrders).flat()]
  }, [context])

  // persisted events：从 event-log.jsonl 分页读取
  const [persisted, setPersisted] = useState<AgentAction[]>([])

  // 滚动位置
  const [scrollTop, setScrollTop] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 合并日志条目（live + persisted，live 在前表示当前回合）
  const entries = useMemo<LogEntry[]>(() => {
    const live: LogEntry[] = liveEnvelopes.map((env) => ({
      key: `live-${env.sequence}`,
      source: 'live',
      turn: env.turn,
      text: `${env.intent}：${formatEnvelopeBrief(env)}`,
      tag: '当前',
    }))
    const persistedEntries: LogEntry[] = persisted.map((evt) => ({
      key: `p-${evt.id}`,
      source: evt.source,
      turn: evt.turn,
      text: evt.text ?? JSON.stringify(evt.payload),
      tag: evt.kind,
    }))
    return [...live, ...persistedEntries]
  }, [liveEnvelopes, persisted])

  // 拉取持久化事件（saveId/turnIndex 变化时刷新）
  const refresh = useCallback(async (): Promise<void> => {
    if (saveId === null) {
      setPersisted([])
      return
    }
    try {
      const events = await readEventLog(saveId, 0, 500)
      setPersisted(events)
    } catch {
      // gateway 未就绪/无日志文件：静默清空（不阻断 UI）
      setPersisted([])
    }
  }, [saveId])

  useEffect(() => {
    // 异步拉取持久化事件（setState 在 await 后的回调中，非同步级联渲染）
    let cancelled = false
    void (async () => {
      if (saveId === null) {
        if (!cancelled) setPersisted([])
        return
      }
      try {
        const events = await readEventLog(saveId, 0, 500)
        if (!cancelled) setPersisted(events)
      } catch {
        // gateway 未就绪/无日志文件：静默清空（不阻断 UI）
        if (!cancelled) setPersisted([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [saveId, context?.game.world.turnIndex])

  // —— 虚拟滚动计算 ——
  const total = entries.length
  const totalHeight = total * ITEM_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ITEM_HEIGHT) + OVERSCAN * 2
  const endIndex = Math.min(total, startIndex + visibleCount)
  const visibleEntries = entries.slice(startIndex, endIndex)

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>): void => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  return (
    <section className="panel event-log-panel">
      <h2 className="panel__title">
        事件日志台 <span className="event-log-panel__count">({total})</span>
        <button
          type="button"
          className="event-log-panel__refresh"
          onClick={() => void refresh()}
        >
          刷新
        </button>
      </h2>

      {total === 0 ? (
        <p className="event-log-panel__empty">暂无事件记录。下命令并结算后此处显示事件流。</p>
      ) : (
        // viewport 固定高度 + 滚动已抽到 styles.css .event-log-panel__viewport
        // （原 inline height/overflowY 静态值移除，仅保留 onScroll 与 ref）。
        <div
          ref={scrollRef}
          className="event-log-panel__viewport"
          onScroll={handleScroll}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleEntries.map((entry, i) => {
              const idx = startIndex + i
              return (
                <div
                  key={entry.key}
                  className="event-log-panel__entry"
                  style={{
                    position: 'absolute',
                    top: idx * ITEM_HEIGHT,
                    height: ITEM_HEIGHT,
                    left: 0,
                    right: 0,
                  }}
                >
                  <span className={`event-log-panel__source event-log-panel__source--${entry.source}`}>
                    {sourceLabel(entry.source)}
                  </span>
                  <span className="event-log-panel__turn">T{entry.turn}</span>
                  <span className="event-log-panel__text" title={entry.text}>{entry.text}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

/** 格式化信封为简短描述（日志行用）。 */
function formatEnvelopeBrief(env: ActionEnvelope): string {
  const unitId = (env.payload.unitId as string | undefined) ?? '?'
  const target = env.payload.target as { col: number; row: number } | undefined
  const targetUnit = env.payload.targetUnitId as string | undefined
  const node = env.payload.nodeId as string | undefined
  const targetStr = target ? `(${target.col},${target.row})` : (targetUnit ?? node ?? '')
  return `${unitId} → ${targetStr}`
}

/** 来源标记中文显示（与 styles.css 6 色徽章注释对齐：
 *  physics 青 / director 紫 / rule-engine 黄 / diplomacy 绿 / intel 蓝 / live 青亮） */
function sourceLabel(source: LogEntry['source']): string {
  const labels: Record<string, string> = {
    live: '当前',
    physics: '物理',
    director: '导演',
    'rule-engine': '降级',
    diplomacy: '外交',
    intel: '情报',
  }
  return labels[source] ?? source
}

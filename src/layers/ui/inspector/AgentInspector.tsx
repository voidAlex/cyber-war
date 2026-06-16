/**
 * Agent Inspector（AgentInspector.tsx）— M3 开发模式面板。
 *
 * 职责（对应重写计划「Agent Inspector(dev)」+ 「缓存可观测」）：
 * - 开发模式显示当前回合各 Agent：
 *   - system prompt 分层（estimateCacheLayers L0-L3，字符数）。
 *   - 原始 LLM 输出（partial）。
 *   - 解析后结构化命令（parsedEnvelope）。
 *   - 置信度（confidence）。
 *   - 缓存命中率（hitRate，hit/miss tokens）。
 *   - 错误（若有）。
 * - 累计缓存统计（callCount / 命中率 / 累计 token）。
 * - 生产模式隐藏（import.meta.env.DEV）。
 *
 * @module layers/ui/inspector/AgentInspector
 */

import { type JSX } from 'react'
import { useGameStore, type AgentProgressEntry } from '@/store/game-store'
import { hitRate } from '@/layers/application/services/llm-service'
import type { CacheStats } from '@/layers/application/services/llm-service'

/** 角色 label */
const ROLE_LABELS: Record<string, string> = {
  chief: '参谋长',
  theater: '战区司令',
  commander: '敌方统帅',
  director: '导演部',
}

/** 是否在开发模式（Vite import.meta.env.DEV） */
const IS_DEV = import.meta.env.DEV

/**
 * Agent Inspector 组件（生产模式返回 null，不渲染）。
 */
export default function AgentInspector(): JSX.Element | null {
  // Hooks 必须无条件调用（Rules of Hooks），先订阅再决定是否渲染。
  const agentProgressById = useGameStore((s) => s.agentProgressById)
  const liveEnvelopes = useGameStore((s) => s.liveEnvelopes)
  const cacheStats = useGameStore((s) => s.cacheStats)
  const degraded = useGameStore((s) => s.degraded)
  // 第 2 批：theater/commander resolve 流式 partial（实时，比 entry.partial 更早出现）。
  const agentLiveOutputs = useGameStore((s) => s.agentLiveOutputs)

  // 开关：生产模式隐藏；DEV 模式可被 ?inspector=0 关闭
  const enabled = IS_DEV && new URLSearchParams(globalThis.location?.search ?? '').get('inspector') !== '0'
  if (!enabled) return null

  const entries = Object.values(agentProgressById)

  return (
    <section className="panel agent-inspector">
      <h2 className="panel__title">Agent Inspector <span className="agent-inspector__dev-tag">DEV</span></h2>

      <CacheStatsView stats={cacheStats} degraded={degraded} />

      {entries.length === 0 && liveEnvelopes.length === 0 && (
        <p className="agent-inspector__empty">尚无本回合 Agent 数据（结算后填充）。</p>
      )}

      {entries.length > 0 && (
        <div className="agent-inspector__agents">
          <h3>各 Agent 实时</h3>
          {entries.map((e) => (
            <AgentEntry
              key={e.agentId}
              entry={e}
              livePartial={agentLiveOutputs[e.agentId]}
            />
          ))}
        </div>
      )}

      {liveEnvelopes.length > 0 && (
        <div className="agent-inspector__envelopes">
          <h3>结构化命令（{liveEnvelopes.length}）</h3>
          <ul>
            {liveEnvelopes
              .slice()
              .sort((a, b) => a.sequence - b.sequence)
              .map((env) => (
                <li key={`${env.agentId}-${env.sequence}`} className="agent-inspector__envelope">
                  <code>seq={env.sequence}</code>{' '}
                  <span>{ROLE_LABELS[env.agentRole] ?? env.agentRole}</span>{' '}
                  <span className="agent-inspector__intent">{env.intent}</span>
                  <details>
                    <summary>payload</summary>
                    <pre>{JSON.stringify(env.payload, null, 2)}</pre>
                  </details>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * 单个 Agent 条目。
 *
 * @param entry 进度条目（agentProgressById）
 * @param livePartial 第 2 批流式实时 partial（agentLiveOutputs[agentId]）。
 *   流式进行中优先显示 livePartial（比 entry.partial 更早出现，逐字增长）；
 *   流式结束后 entry.partial 填充，livePartial 已被清空。
 */
function AgentEntry({
  entry,
  livePartial,
}: {
  entry: AgentProgressEntry
  livePartial?: string
}): JSX.Element {
  // 流式 partial 优先（实时）；否则回退 entry.partial（已完成时填充）。
  const partialText = livePartial ?? entry.partial
  const streaming = livePartial !== undefined && livePartial.length > 0
  return (
    <div className={`agent-inspector__entry agent-inspector__entry--${entry.status}`}>
      <div className="agent-inspector__entry-head">
        <strong>{ROLE_LABELS[entry.role] ?? entry.role}</strong>
        <span className="agent-inspector__entry-id">{entry.agentId}</span>
        <span className="agent-inspector__entry-status">
          {streaming ? '流式中' : entry.status}
        </span>
      </div>
      {entry.layers && (
        <div className="agent-inspector__layers">
          分层字符数：L0={entry.layers.l0} L1={entry.layers.l1} L2={entry.layers.l2} L3={entry.layers.l3}
        </div>
      )}
      {(entry.cacheHitTokens !== undefined || entry.cacheMissTokens !== undefined) && (
        <div className="agent-inspector__cache">
          缓存：命中 {entry.cacheHitTokens ?? 0} / 未命中 {entry.cacheMissTokens ?? 0} token
        </div>
      )}
      {entry.confidence !== undefined && (
        <div className="agent-inspector__confidence">置信度：{entry.confidence}</div>
      )}
      {partialText && (
        <details className="agent-inspector__raw" open={streaming}>
          <summary>
            {streaming ? '流式输出（' : '原始输出（'}{partialText.length} 字符）
          </summary>
          <pre>{partialText}</pre>
        </details>
      )}
      {entry.parsedEnvelope && (
        <div className="agent-inspector__parsed">
          解析命令：<code>{entry.parsedEnvelope.intent}</code>
        </div>
      )}
      {entry.error && (
        <div className="agent-inspector__error" role="alert">错误：{entry.error}</div>
      )}
    </div>
  )
}

/** 累计缓存统计视图 */
function CacheStatsView({ stats, degraded }: { stats: CacheStats; degraded: boolean }): JSX.Element {
  const rate = hitRate(stats)
  const pct = (rate * 100).toFixed(1)
  return (
    <div className="agent-inspector__cache-stats">
      <h3>累计缓存统计</h3>
      <dl>
        <div><dt>调用次数</dt><dd>{stats.callCount}</dd></div>
        <div><dt>命中率</dt><dd>{pct}%</dd></div>
        <div><dt>命中 token</dt><dd>{stats.totalHitTokens}</dd></div>
        <div><dt>未命中 token</dt><dd>{stats.totalMissTokens}</dd></div>
        <div><dt>累计输入</dt><dd>{stats.totalInputTokens}</dd></div>
        <div><dt>累计输出</dt><dd>{stats.totalOutputTokens}</dd></div>
        <div><dt>降级次数</dt><dd>{stats.degradedCount}</dd></div>
        <div><dt>本回合降级</dt><dd>{degraded ? '是' : '否'}</dd></div>
      </dl>
    </div>
  )
}

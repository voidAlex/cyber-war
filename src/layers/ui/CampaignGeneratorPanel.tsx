/**
 * 战役生成器面板（CampaignGeneratorPanel.tsx）— M4-C 内置战役生成器 UI。
 *
 * 对应 doc/tech-design-v1.0.md §3.11 + doc/prd-v1.0.md §7.1。
 *
 * 职责：
 * - 自然语言需求输入框（占位提示常见战役）。
 * - 生成按钮 → generateCampaign → 显示阶段进度（研究员/设计师/校验/平衡）。
 * - 预览生成 CampaignPayload（七文件摘要 + warnings/存疑标注）。
 * - 「确认导入开局」→ startCampaignFromPayload；或「重新生成」。
 *
 * 经 zustand store 订阅 busy/userError/config；apiKey 通过 buildLlmCallConfig
 * 从会话取（即用即抛，不进 store）。不直接调 @tauri-apps/api。
 *
 * @module layers/ui/CampaignGeneratorPanel
 */

import { useState, type JSX } from 'react'
import { useGameStore, buildLlmCallConfig } from '@/store/game-store'
import { Play, AlertTriangle } from '@/layers/ui/icons'
import { createLlmService } from '@/layers/application/services/llm-service'
import {
  generateCampaign,
  type GenerateCampaignResult,
  type GeneratorStage,
} from '@/layers/agents/generator'
import {
  startCampaignFromPayload,
} from '@/layers/persistence'
import type { CampaignPayload } from '@/types'

/** 生成阶段中文标签 */
const STAGE_LABELS: Record<GeneratorStage, string> = {
  researcher: '史实研究员',
  designer: '战役设计师',
  'schema-validate': 'schema 校验',
  balancer: '平衡校验',
  fallback: '降级模板包',
  done: '完成',
}

/**
 * 战役生成器面板组件。
 */
export default function CampaignGeneratorPanel(): JSX.Element {
  const busy = useGameStore((s) => s.busy)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const setFromWorld = useGameStore((s) => s.setFromWorld)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const clearError = useGameStore((s) => s.clearError)

  // 玩家自然语言需求
  const [request, setRequest] = useState('')
  // 生成中
  const [generating, setGenerating] = useState(false)
  // 当前阶段
  const [stage, setStage] = useState<GeneratorStage | null>(null)
  const [stageDetail, setStageDetail] = useState('')
  // 生成结果
  const [result, setResult] = useState<GenerateCampaignResult | null>(null)
  // 确认开局所选阵营
  const [confirmFaction, setConfirmFaction] = useState('')
  const [message, setMessage] = useState('')

  const canGenerate =
    !busy && !generating && configUnlocked && request.trim().length > 0

  // —— 生成 ——
  const handleGenerate = async (): Promise<void> => {
    clearError()
    setMessage('')
    setResult(null)

    const cfg = buildLlmCallConfig()
    if (cfg === null) {
      setMessage('请先在设置面板解锁 LLM 配置（含 API Key）')
      return
    }

    setGenerating(true)
    setStage('researcher')
    setStageDetail('启动…')
    try {
      const llmService = createLlmService()
      const res = await generateCampaign(
        { playerRequest: request.trim() },
        llmService,
        cfg,
        (st, detail) => {
          setStage(st)
          setStageDetail(detail ?? '')
        },
      )
      setResult(res)
      setConfirmFaction(res.payload.manifest.playerFactionIds[0] ?? '')
      setStage(null)
      setMessage(
        res.degraded
          ? '生成完成（降级模板包，请查看警告）'
          : '生成完成，请预览后确认开局',
      )
    } catch (err) {
      setStage(null)
      setMessage(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setGenerating(false)
    }
  }

  // —— 确认导入开局 ——
  const handleConfirmStart = async (): Promise<void> => {
    if (!result) return
    clearError()
    setMessage('')
    try {
      const newSaveId = `${result.payload.manifest.scenarioId}-${Date.now()}`
      const world = await startCampaignFromPayload(
        result.payload,
        newSaveId,
        confirmFaction,
      )
      setFromWorld(world, newSaveId)
      await refreshSaves()
      setMessage(`已开局生成战役「${result.payload.manifest.displayName}」，存档 ${newSaveId}`)
      setResult(null)
      setRequest('')
    } catch (err) {
      setMessage(`开局失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <section className="panel campaign-generator-panel">
      <h3 className="campaign-panel__subtitle">生成新战役（LLM）</h3>

      {/* 需求输入 */}
      <div className="campaign-panel__row">
        <input
          type="text"
          placeholder="如：库尔斯克会战 / 1944西线装甲突击 / 两方均衡海岛攻防"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          disabled={busy || generating}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={!canGenerate}
        >
          {generating ? '生成中…' : '生成战役'}
        </button>
      </div>

      {!configUnlocked && (
        <p className="campaign-panel__hint">
          需先在设置面板解锁 LLM 配置（含 API Key）才能生成战役。
        </p>
      )}
      <p className="campaign-panel__hint">
        史实来源以 LLM 内置知识为主；冷门事实标「存疑」，虚构需求标「非史实」。
      </p>

      {/* 阶段进度 */}
      {generating && stage && (
        <div className="campaign-generator-panel__stage">
          <span className="campaign-generator-panel__spinner" aria-hidden />
          <span className="campaign-generator-panel__stage-active">
            <Play size={11} aria-hidden /> {STAGE_LABELS[stage]}
            {stageDetail ? `：${stageDetail}` : ''}
          </span>
        </div>
      )}

      {/* 生成结果预览 */}
      {result && (
        <CampaignPreview
          payload={result.payload}
          warnings={result.warnings}
          degraded={result.degraded}
          confirmFaction={confirmFaction}
          onFactionChange={setConfirmFaction}
          onConfirm={() => void handleConfirmStart()}
          onRegenerate={() => {
            setResult(null)
            setMessage('')
          }}
          busy={busy}
        />
      )}

      {message && <p className="campaign-panel__message">{message}</p>}
    </section>
  )
}

// =============================================================================
// CampaignPreview：七文件摘要 + warnings + 确认/重新生成
// =============================================================================

interface CampaignPreviewProps {
  payload: CampaignPayload
  warnings: string[]
  degraded: boolean
  confirmFaction: string
  onFactionChange: (faction: string) => void
  onConfirm: () => void
  onRegenerate: () => void
  busy: boolean
}

/** 七文件摘要预览（阵营/单位数/指挥官/节点/胜负条件数） */
function CampaignPreview(props: CampaignPreviewProps): JSX.Element {
  const { payload, warnings, degraded } = props
  const factions = payload.factions
  const unitCount = payload.units.length
  const nodeCount = payload.map.highValueNodes.length
  const condCount = payload.victory.conditions.length

  return (
    <div className="campaign-panel__confirm campaign-generator-panel__preview">
      <div className="campaign-generator-panel__summary">
        <strong>{payload.manifest.displayName}</strong>
        {degraded && (
          <span className="campaign-generator-panel__badge">降级模板</span>
        )}
        <div>
          阵营：{factions.map((f) => `${f.name}(${f.side})`).join(' / ')}
        </div>
        <div>
          单位 {unitCount} · 高价值节点 {nodeCount} · 胜负条件 {condCount} ·
          回合上限 {payload.victory.maxTurns}
        </div>
        {payload.manifest.description && (
          <div className="campaign-panel__hint">
            {payload.manifest.description}
          </div>
        )}
      </div>

      {/* 警告 / 存疑 / 非史实标注 */}
      {warnings.length > 0 && (
        <ul className="campaign-generator-panel__warnings">
          {warnings.map((w, i) => (
            <li key={i}>
              <AlertTriangle size={12} aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}

      {/* 确认开局 */}
      <div className="campaign-panel__row">
        <select
          value={props.confirmFaction}
          onChange={(e) => props.onFactionChange(e.target.value)}
          disabled={props.busy}
        >
          {payload.manifest.playerFactionIds.map((fid) => (
            <option key={fid} value={fid}>
              {fid}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={props.onConfirm}
          disabled={props.busy || props.confirmFaction.length === 0}
        >
          确认导入开局
        </button>
        <button
          type="button"
          onClick={props.onRegenerate}
          disabled={props.busy}
        >
          重新生成
        </button>
      </div>
    </div>
  )
}

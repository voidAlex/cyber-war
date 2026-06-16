/**
 * 创建战役独立页（CampaignCreatorPage.tsx）— 第 5 批 D。
 *
 * 对应重写计划「第 5 批：创建战役独立页」。独立页面（非弹窗），App.tsx 路由第四态
 * `creatorPage`（configLock → titleScreen → creatorPage → inGame）。
 *
 * 步骤式 wizard（5 步，可回退）：
 * - Step 1 需求输入：自然语言文本框 + 示例提示。
 * - Step 2 研究员输出：LLM 实时阶段进度 + 完成后展示史实依据（research.outcome/notes）。
 * - Step 3 设计师输出：LLM 实时阶段进度 + 完成后展示七文件预览（CampaignPayload 摘要）。
 * - Step 4 校验：ajv schema 校验 + 平衡迭代进度（generator 内部已含，此处展示进度）。
 * - Step 5 预览确认：七文件摘要 + 可选阵营 + 「确认开局」→ initSave。
 *
 * 设计说明：
 * - 流式进度复用 generateCampaign 的 onStage 回调（GeneratorStage）→ 映射到 wizard 当前步骤。
 *   generator 当前是「一次性返回完整结果」封装，研究员/设计师的具体输出文本在结果返回后展示
 *   （research.outcome/notes + payload 摘要），阶段进度（researcher→designer→schema-validate→
 *   balancer）实时流式反映在步骤高亮上。
 * - 复用 CampaignGeneratorPanel 的 generateCampaign + startCampaignFromPayload 调用链路。
 * - 经 zustand store 订阅 busy/userError/configUnlocked；apiKey 通过 buildLlmCallConfig 即用即抛。
 * - gateway 唯一 import @tauri-apps/api；本组件经 store/hooks，不直接调 gateway。
 *
 * @module layers/ui/campaign-creator/CampaignCreatorPage
 */

import { useState, useCallback, type JSX } from 'react'
import { useGameStore, buildLlmCallConfig } from '@/store/game-store'
import { createLlmService } from '@/layers/application/services/llm-service'
import {
  generateCampaign,
  type GenerateCampaignResult,
  type GeneratorStage,
  type ResearcherOutput,
} from '@/layers/agents/generator'
import { startCampaignFromPayload } from '@/layers/persistence'
import type { CampaignPayload } from '@/types'
import { logger } from '@/utils/logger'

/** wizard 步骤（与 GeneratorStage 映射，加 idle/done 边界态） */
type WizardStep = 1 | 2 | 3 | 4 | 5

/** GeneratorStage → wizard 步骤映射（进度推进用） */
function stageToStep(stage: GeneratorStage | null): WizardStep {
  switch (stage) {
    case 'researcher':
      return 2
    case 'designer':
      return 3
    case 'schema-validate':
      return 4
    case 'balancer':
      return 4
    case 'fallback':
      return 4
    case 'done':
      return 5
    default:
      return 1
  }
}

/** 步骤中文标题 */
const STEP_TITLES: Record<WizardStep, string> = {
  1: '需求输入',
  2: '研究员 · 史实依据',
  3: '设计师 · 战役草案',
  4: '校验 · schema + 平衡',
  5: '预览确认 · 开局',
}

/** 阶段中文标签（流式进度条用） */
const STAGE_LABELS: Record<GeneratorStage, string> = {
  researcher: '史实研究员',
  designer: '战役设计师',
  'schema-validate': 'schema 校验',
  balancer: '平衡校验',
  fallback: '降级模板包',
  done: '完成',
}

/** 示例需求提示（点击填入输入框） */
const EXAMPLE_PROMPTS = [
  '库尔斯克会战 1943（苏德双方装甲决战）',
  '1944 西线阿登反击战（盟军 vs 德军）',
  '两方均衡的海岛攻防（虚构，蓝方登陆 vs 红方据守）',
  '斯大林格勒 1942（城市巷战，苏军包围德第六集团军）',
]

/**
 * 创建战役独立页组件。
 *
 * @param onExit 退出回标题屏（App 切回 titleScreen 态）
 */
export default function CampaignCreatorPage({
  onExit,
}: {
  onExit: () => void
}): JSX.Element {
  const busy = useGameStore((s) => s.busy)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const setFromWorld = useGameStore((s) => s.setFromWorld)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const clearError = useGameStore((s) => s.clearError)

  // 当前 wizard 步骤（1..5）
  const [step, setStep] = useState<WizardStep>(1)
  // 玩家自然语言需求
  const [request, setRequest] = useState('')
  // 生成中（generateCampaign 进行中）
  const [generating, setGenerating] = useState(false)
  // 当前 GeneratorStage（流式进度条）
  const [stage, setStage] = useState<GeneratorStage | null>(null)
  const [stageDetail, setStageDetail] = useState('')
  // 生成结果（完成后存）
  const [result, setResult] = useState<GenerateCampaignResult | null>(null)
  // 确认开局所选阵营
  const [confirmFaction, setConfirmFaction] = useState('')
  const [message, setMessage] = useState('')

  const canGenerate =
    !busy && !generating && configUnlocked && request.trim().length > 0

  // —— 启动生成（Step 1 → 推进到 Step 2..5，由 onStage 驱动）——
  const handleGenerate = useCallback(async (): Promise<void> => {
    clearError()
    setMessage('')
    setResult(null)
    setStage('researcher')
    setStageDetail('启动…')
    setStep(2)

    const cfg = buildLlmCallConfig()
    if (cfg === null) {
      setMessage('请先在设置面板解锁 LLM 配置（含 API Key）')
      setStep(1)
      setStage(null)
      return
    }

    setGenerating(true)
    logger.info('ui/creator/generate', '启动战役生成', {
      scope: 'app',
      requestLen: request.trim().length,
    })
    try {
      const llmService = createLlmService()
      const res = await generateCampaign(
        { playerRequest: request.trim() },
        llmService,
        cfg,
        (st, detail) => {
          setStage(st)
          setStageDetail(detail ?? '')
          // 进度回调驱动 wizard 步骤推进
          setStep((cur) => Math.max(cur, stageToStep(st)) as WizardStep)
        },
      )
      setResult(res)
      setConfirmFaction(res.payload.manifest.playerFactionIds[0] ?? '')
      setStage(null)
      setStep(5)
      setMessage(
        res.degraded
          ? '生成完成（降级模板包，请查看警告）'
          : '生成完成，请预览后确认开局',
      )
    } catch (err) {
      setStage(null)
      setStep(1)
      setMessage(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setGenerating(false)
    }
  }, [request, clearError])

  // —— 确认开局（Step 5 → initSave → setFromWorld → App 切 inGame）——
  const handleConfirmStart = useCallback(async (): Promise<void> => {
    if (!result) return
    clearError()
    setMessage('')
    try {
      const newSaveId = `${result.payload.manifest.scenarioId}-${Date.now()}`
      logger.info('ui/creator/start', '确认开局生成战役', {
        scope: 'app',
        saveId: newSaveId,
        faction: confirmFaction,
      })
      const world = await startCampaignFromPayload(
        result.payload,
        newSaveId,
        confirmFaction,
      )
      setFromWorld(world, newSaveId)
      await refreshSaves()
      // setFromWorld 后 context !== null，App 自动切 inGame，本组件卸载
    } catch (err) {
      setMessage(`开局失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [result, confirmFaction, clearError, setFromWorld, refreshSaves])

  // —— 回退到指定步骤（仅允许回退到已完成或当前步骤之前）——
  const handleGoBack = (target: WizardStep): void => {
    if (generating) return
    if (target >= step) return
    setStep(target)
    // 回退到 Step 1 时清空结果（允许重新输入需求）
    if (target === 1) {
      setResult(null)
      setStage(null)
      setMessage('')
    }
  }

  return (
    <div className="creator-page" role="main" aria-label="创建战役">
      {/* 顶部：标题 + 退出 */}
      <header className="creator-page__header">
        <h1 className="creator-page__title">生成新战役</h1>
        <p className="creator-page__subtitle">
          LLM 驱动 · 研究员梳理史实 → 设计师产出七文件 → schema 校验 → 预览开局
        </p>
        <button
          type="button"
          className="creator-page__exit"
          onClick={onExit}
          disabled={generating}
        >
          ← 返回标题屏
        </button>
      </header>

      {/* 步骤指示器（1..5） */}
      <nav className="creator-page__steps" aria-label="生成步骤">
        {([1, 2, 3, 4, 5] as WizardStep[]).map((s) => (
          <button
            key={s}
            type="button"
            className={
              'creator-page__step' +
              (s === step ? ' creator-page__step--active' : '') +
              (s < step ? ' creator-page__step--done' : '') +
              (generating && s > step ? ' creator-page__step--pending' : '')
            }
            onClick={() => handleGoBack(s)}
            disabled={generating || s > step}
            aria-current={s === step ? 'step' : undefined}
          >
            <span className="creator-page__step-num">{s}</span>
            <span className="creator-page__step-label">{STEP_TITLES[s]}</span>
          </button>
        ))}
      </nav>

      {/* 步骤内容区 */}
      <main className="creator-page__body">
        {/* Step 1: 需求输入 */}
        {step === 1 && (
          <StepRequest
            request={request}
            onChange={setRequest}
            onGenerate={() => void handleGenerate()}
            canGenerate={canGenerate}
            configUnlocked={configUnlocked}
            message={message}
          />
        )}

        {/* Step 2-4: 生成中（流式进度 + 阶段详情） */}
        {(step === 2 || step === 3 || step === 4) && (
          <StepGenerating
            step={step}
            stage={stage}
            stageDetail={stageDetail}
            generating={generating}
          />
        )}

        {/* Step 5: 预览确认 */}
        {step === 5 && result && (
          <StepPreview
            payload={result.payload}
            research={result.research}
            warnings={result.warnings}
            degraded={result.degraded}
            confirmFaction={confirmFaction}
            onFactionChange={setConfirmFaction}
            onConfirm={() => void handleConfirmStart()}
            onRegenerate={() => {
              setResult(null)
              setStep(1)
              setMessage('')
            }}
            busy={busy}
            message={message}
          />
        )}
      </main>
    </div>
  )
}

// =============================================================================
// Step 1: 需求输入
// =============================================================================

interface StepRequestProps {
  request: string
  onChange: (v: string) => void
  onGenerate: () => void
  canGenerate: boolean
  configUnlocked: boolean
  message: string
}

/** Step 1：需求输入（自然语言文本框 + 示例提示） */
function StepRequest(props: StepRequestProps): JSX.Element {
  const { request, onChange, onGenerate, canGenerate, configUnlocked, message } = props
  return (
    <section className="creator-step creator-step--request">
      <h2 className="creator-step__title">描述你想要的战役</h2>
      <p className="creator-step__hint">
        用自然语言描述战役背景、双方阵营、关键节点、胜负目标。史实或虚构均可。
      </p>

      <textarea
        className="creator-step__textarea"
        placeholder={
          '如：1943 年库尔斯克会战，苏德双方在普罗霍罗夫卡展开史上最大坦克战。' +
          '苏军（守方）依托纵深防御，德军（攻方）集中装甲突击……'
        }
        value={request}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        disabled={!configUnlocked}
      />

      {/* 示例提示（点击填入） */}
      <div className="creator-step__examples">
        <span className="creator-step__examples-label">示例：</span>
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            className="creator-step__example-chip"
            onClick={() => onChange(p)}
            disabled={!configUnlocked}
          >
            {p}
          </button>
        ))}
      </div>

      {!configUnlocked && (
        <p className="creator-step__warn">
          需先在设置面板解锁 LLM 配置（含 API Key）才能生成战役。
        </p>
      )}

      <div className="creator-step__actions">
        <button
          type="button"
          className="creator-step__primary-btn"
          onClick={onGenerate}
          disabled={!canGenerate}
        >
          开始生成 →
        </button>
      </div>

      {message && <p className="creator-step__message creator-step__message--error">{message}</p>}
    </section>
  )
}

// =============================================================================
// Step 2-4: 生成中（流式进度）
// =============================================================================

interface StepGeneratingProps {
  step: WizardStep
  stage: GeneratorStage | null
  stageDetail: string
  generating: boolean
}

/** Step 2-4：生成中，展示当前阶段 + 进度条 */
function StepGenerating(props: StepGeneratingProps): JSX.Element {
  const { step, stage, stageDetail, generating } = props
  return (
    <section className="creator-step creator-step--generating">
      <h2 className="creator-step__title">{STEP_TITLES[step]}</h2>

      {/* 流式进度条（当前阶段高亮） */}
      <div className="creator-progress">
        {(['researcher', 'designer', 'schema-validate', 'balancer'] as GeneratorStage[]).map(
          (s) => {
            const idx = stageToStep(s)
            const isActive = stage === s
            const isDone = step > idx || (step === 5)
            return (
              <div
                key={s}
                className={
                  'creator-progress__item' +
                  (isActive ? ' creator-progress__item--active' : '') +
                  (isDone ? ' creator-progress__item--done' : '')
                }
              >
                <span className="creator-progress__dot" />
                <span className="creator-progress__label">{STAGE_LABELS[s]}</span>
              </div>
            )
          },
        )}
      </div>

      {/* 当前阶段详情 */}
      <div className="creator-step__stage-detail">
        {generating && stage && (
          <>
            <span className="creator-step__spinner" aria-hidden />
            <span className="creator-step__stage-text">
              {STAGE_LABELS[stage]}
              {stageDetail ? `：${stageDetail}` : '…'}
            </span>
          </>
        )}
        {!generating && (
          <span className="creator-step__stage-text">
            {step === 5 ? '生成完成，进入预览…' : '等待生成…'}
          </span>
        )}
      </div>

      <p className="creator-step__hint">
        LLM 正在多 Agent 协作：研究员梳理史实 → 设计师生成七文件 → schema 校验 → 平衡迭代。
        阶段切换时步骤指示器自动推进。
      </p>
    </section>
  )
}

// =============================================================================
// Step 5: 预览确认
// =============================================================================

interface StepPreviewProps {
  payload: CampaignPayload
  research: ResearcherOutput
  warnings: string[]
  degraded: boolean
  confirmFaction: string
  onFactionChange: (f: string) => void
  onConfirm: () => void
  onRegenerate: () => void
  busy: boolean
  message: string
}

/** Step 5：预览确认（七文件摘要 + 研究员产出 + 阵营选择 → 确认开局） */
function StepPreview(props: StepPreviewProps): JSX.Element {
  const {
    payload,
    research,
    warnings,
    degraded,
    confirmFaction,
    onFactionChange,
    onConfirm,
    onRegenerate,
    busy,
    message,
  } = props

  const factions = payload.factions
  const unitCount = payload.units.length
  const nodeCount = payload.map.highValueNodes.length
  const condCount = payload.victory.conditions.length
  // 第 5 批：装备统计（有装备的单位数）
  const equippedCount = payload.units.filter((u) => u.equipment && u.equipment.length > 0).length

  return (
    <section className="creator-step creator-step--preview">
      <h2 className="creator-step__title">预览生成的战役包</h2>

      {/* 研究员产出摘要（史实依据） */}
      <div className="creator-preview__block">
        <h3 className="creator-preview__block-title">史实依据（研究员）</h3>
        <dl className="creator-preview__research">
          <div>
            <dt>性质</dt>
            <dd>{research.historical ? '史实' : '虚构/非史实'}</dd>
          </div>
          {research.outcome && (
            <div>
              <dt>结局</dt>
              <dd>{research.outcome}</dd>
            </div>
          )}
          {research.notes && (
            <div>
              <dt>备注</dt>
              <dd>{research.notes}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* 七文件摘要 */}
      <div className="creator-preview__block">
        <h3 className="creator-preview__block-title">战役包摘要（设计师）</h3>
        <div className="creator-preview__summary">
          <strong>{payload.manifest.displayName}</strong>
          {degraded && <span className="creator-preview__badge">降级模板</span>}
          <div className="creator-preview__factions">
            {factions.map((f) => (
              <span
                key={f.id}
                className="creator-preview__faction"
                style={{ borderColor: f.color }}
              >
                <span
                  className="creator-preview__faction-dot"
                  style={{ background: f.color }}
                  aria-hidden
                />
                {f.name}（{f.side}）
              </span>
            ))}
          </div>
          <div className="creator-preview__stats">
            单位 {unitCount}（含装备 {equippedCount}）· 高价值节点 {nodeCount} ·
            胜负条件 {condCount} · 回合上限 {payload.victory.maxTurns}
          </div>
          {payload.manifest.description && (
            <p className="creator-preview__desc">{payload.manifest.description}</p>
          )}
        </div>
      </div>

      {/* 警告 / 存疑 / 非史实 */}
      {warnings.length > 0 && (
        <div className="creator-preview__block">
          <h3 className="creator-preview__block-title">⚠ 警告 / 存疑</h3>
          <ul className="creator-preview__warnings">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 阵营选择 + 确认开局 */}
      <div className="creator-preview__confirm">
        <label className="creator-preview__faction-label">
          选择阵营开局：
          <select
            value={confirmFaction}
            onChange={(e) => onFactionChange(e.target.value)}
            disabled={busy}
          >
            {payload.manifest.playerFactionIds.map((fid) => (
              <option key={fid} value={fid}>
                {fid}
              </option>
            ))}
          </select>
        </label>
        <div className="creator-preview__actions">
          <button
            type="button"
            className="creator-step__primary-btn"
            onClick={onConfirm}
            disabled={busy || confirmFaction.length === 0}
          >
            确认开局 →
          </button>
          <button
            type="button"
            className="creator-step__secondary-btn"
            onClick={onRegenerate}
            disabled={busy}
          >
            重新生成
          </button>
        </div>
      </div>

      {message && <p className="creator-step__message">{message}</p>}
    </section>
  )
}

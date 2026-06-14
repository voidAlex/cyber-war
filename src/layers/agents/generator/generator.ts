/**
 * 战役生成器编排（generator.ts）— 多 Agent 编排入口。
 *
 * 对应 doc/tech-design-v1.0.md §3.11「生成器 Agent 编排」。
 *
 * 流程（确定性 sequence，但 LLM 创作允许非确定；产物固化即可回放）：
 * 1. researcher：玩家需求 → ResearcherOutput（史实依据 + 存疑/非史实标注）。
 * 2. designer：ResearcherOutput → CampaignPayload 草案。
 * 3. validateCampaignPayload（ajv schema 校验）：
 *    - 通过 → 进入 balancer；
 *    - 失败 → 把 errors 反馈 designer 迭代修正（最多 MAX_DESIGNER_RETRIES 次）。
 * 4. balancer：草案 → BalancerOutput（数值平衡/胜利可达/规模/公平）。
 *    - pass → 完成；
 *    - 不 pass → 把 issues/suggestions 反馈 designer 迭代（最多 MAX_BALANCE_RETRIES 次）。
 * 5. 注入固定 scenarioSeed（确定性）+ 收集 warnings（存疑/非史实/降级）。
 * 6. 多次 schema 失败 → 降级模板包（buildTemplateFallback，绝不输出非法 payload）。
 *
 * 进度回调 onStage：UI 据此显示「研究员 / 设计师 / 校验 / 平衡」各阶段。
 *
 * @module layers/agents/generator/generator
 */

import type { LlmService } from '@/layers/application/services/llm-service'
import type { LlmCallConfig } from '@/layers/agents/roles/llm-role-base'
import type { CampaignPayload } from '@/types'
import { validateCampaignPayload, CampaignSchemaError } from '@/layers/persistence/campaign-zip'
import { runResearcher } from './researcher'
import { runDesigner } from './designer'
import { runBalancer } from './balancer'
import type { ResearcherOutput } from './generator-schema'
import {
  buildTemplateFallback,
  makeScenarioSeed,
  toScenarioId,
} from './template-fallback'

/** 设计师 schema 校验失败最大重试次数 */
export const MAX_DESIGNER_RETRIES = 2
/** balancer 不通过最大迭代次数 */
export const MAX_BALANCE_RETRIES = 2

/** 生成阶段（供 UI 进度展示） */
export type GeneratorStage =
  | 'researcher'
  | 'designer'
  | 'schema-validate'
  | 'balancer'
  | 'fallback'
  | 'done'

/** 进度回调（每阶段开始/结束触发） */
export type ProgressCallback = (stage: GeneratorStage, detail?: string) => void

/** 生成结果 */
export interface GenerateCampaignResult {
  /** 最终 CampaignPayload（必为 schema 合法） */
  payload: CampaignPayload
  /** 研究员产出（含存疑/非史实标注，供 UI 展示） */
  research: ResearcherOutput
  /** 警告列表（存疑事实/非史实/降级/平衡 issues） */
  warnings: string[]
  /** 是否降级为模板包 */
  degraded: boolean
}

/** 生成请求 */
export interface GenerateCampaignRequest {
  /** 玩家自然语言需求 */
  playerRequest: string
}

/**
 * 生成战役包：玩家需求 → { payload, warnings }。
 *
 * @param request 生成请求（含玩家需求）
 * @param llmService LLM 服务（注入，测试可 mock）
 * @param cfg LLM 调用配置（provider/endpoint/model/apiKey）
 * @param onStage 可选进度回调
 * @returns 生成结果（payload 必 schema 合法 + warnings）
 */
export async function generateCampaign(
  request: GenerateCampaignRequest,
  llmService: LlmService,
  cfg: LlmCallConfig,
  onStage?: ProgressCallback,
): Promise<GenerateCampaignResult> {
  const warnings: string[] = []

  // === 1. 研究员 ===
  onStage?.('researcher', '研究员梳理史实依据…')
  const { data: research } = await runResearcher(
    llmService,
    cfg,
    request.playerRequest,
  )

  // 虚构/非史实标注 → warnings（UI 明示）
  if (!research.historical) {
    warnings.push('非史实：玩家需求为虚构/架空/自定义，事实字段已标存疑。')
  }
  // 存疑事实 → warnings（提示玩家核对）
  const uncertain = research.facts.filter((f) => f.isUncertain)
  if (uncertain.length > 0) {
    warnings.push(
      `存疑事实（请玩家核对）：${uncertain.map((f) => f.claim).join('；')}`,
    )
  }

  // === 2/3. 设计师 + schema 校验（迭代） ===
  let payload: CampaignPayload | null = null
  let lastSchemaError: string | undefined
  for (let attempt = 0; attempt <= MAX_DESIGNER_RETRIES; attempt++) {
    onStage?.('designer', `设计师产出战役包草案（第 ${attempt + 1} 次）…`)
    const result = await runDesigner(
      llmService,
      cfg,
      research,
      request.playerRequest,
      lastSchemaError,
    )

    // 注入固定 scenarioSeed / scenarioId（设计师留空，schema 要求非空）。
    // 生成时确定（确定性基底），产物固化即可回放。
    const sid =
      result.payload.manifest.scenarioId && result.payload.manifest.scenarioId.length > 0
        ? result.payload.manifest.scenarioId
        : toScenarioId(research.name)
    const seed =
      result.payload.manifest.scenarioSeed && result.payload.manifest.scenarioSeed.length > 0
        ? result.payload.manifest.scenarioSeed
        : makeScenarioSeed(request.playerRequest, sid)
    const seeded: CampaignPayload = {
      ...result.payload,
      manifest: { ...result.payload.manifest, scenarioId: sid, scenarioSeed: seed },
    }

    onStage?.('schema-validate', 'schema 校验…')
    try {
      validateCampaignPayload(seeded)
      payload = seeded
      break
    } catch (err) {
      if (err instanceof CampaignSchemaError) {
        const detail = err.errors
          ? err.errors
              .map((e) => `${e.instancePath || '(root)'}: ${JSON.stringify(e.message ?? e)}`)
              .join('; ')
          : err.message
        lastSchemaError = `文件 ${err.file} 校验失败：${detail}`
        warnings.push(
          `设计师第 ${attempt + 1} 次 schema 校验失败（${err.file}），将反馈修正。`,
        )
      } else {
        lastSchemaError = err instanceof Error ? err.message : String(err)
        warnings.push(`设计师第 ${attempt + 1} 次校验异常：${lastSchemaError}`)
      }
      // 继续下一次迭代（若未超 MAX_DESIGNER_RETRIES）
    }
  }

  // 多次 schema 失败 → 降级模板包
  if (payload === null) {
    onStage?.('fallback', '多次 schema 校验失败，降级模板包…')
    const fallback = buildTemplateFallback(research, request.playerRequest)
    // 模板包必合法，但仍校验一次保险（绝不输出非法 payload）
    validateCampaignPayload(fallback.payload)
    warnings.push(...fallback.warnings)
    onStage?.('done', '降级模板包就绪。')
    return {
      payload: fallback.payload,
      research,
      warnings,
      degraded: true,
    }
  }

  // === 4. 平衡校验（迭代） ===
  let balanced = false
  for (let attempt = 0; attempt < MAX_BALANCE_RETRIES; attempt++) {
    onStage?.('balancer', `平衡校验（第 ${attempt + 1} 次）…`)
    const { data: review } = await runBalancer(llmService, cfg, payload, research)
    if (review.pass) {
      balanced = true
      break
    }
    // 不通过：收集 issues + 反馈设计师迭代
    const issueText =
      (review.issues ?? [])
        .map((i) => `${i.field}: ${i.problem}`)
        .join('; ') + (review.suggestions ? ` 建议: ${review.suggestions.join('; ')}` : '')
    warnings.push(`平衡校验第 ${attempt + 1} 次未通过：${issueText}`)

    // 反馈设计师修正（一次 designer + schema 校验）
    onStage?.('designer', `设计师按平衡意见修正（第 ${attempt + 1} 次）…`)
    const fixed = await runDesigner(
      llmService,
      cfg,
      research,
      request.playerRequest,
      `平衡校验意见：${issueText}`,
    )
    try {
      // 注入 seed（与首轮一致），再校验
      const fixedSid =
        fixed.payload.manifest.scenarioId && fixed.payload.manifest.scenarioId.length > 0
          ? fixed.payload.manifest.scenarioId
          : toScenarioId(research.name)
      const fixedSeed =
        fixed.payload.manifest.scenarioSeed && fixed.payload.manifest.scenarioSeed.length > 0
          ? fixed.payload.manifest.scenarioSeed
          : makeScenarioSeed(request.playerRequest, fixedSid)
      const fixedSeeded: CampaignPayload = {
        ...fixed.payload,
        manifest: { ...fixed.payload.manifest, scenarioId: fixedSid, scenarioSeed: fixedSeed },
      }
      validateCampaignPayload(fixedSeeded)
      payload = fixedSeeded
    } catch (err) {
      // 修正后 schema 反而失败：保留原 payload，继续下一轮 balancer
      warnings.push(
        `设计师修正后 schema 校验失败（${err instanceof CampaignSchemaError ? err.file : '未知'}），保留上一版。`,
      )
    }
  }

  if (!balanced) {
    warnings.push('平衡校验多次未通过，已采用最新草案（玩家可在预览中评估平衡性）。')
  }

  // === 5. 注入固定 scenarioSeed（确定性） ===
  // 设计师产出时 scenarioSeed 为空，此处注入固定种子（产物固化即可回放）。
  const scenarioId =
    payload.manifest.scenarioId && payload.manifest.scenarioId.length > 0
      ? payload.manifest.scenarioId
      : toScenarioId(research.name)
  const seed = makeScenarioSeed(request.playerRequest, scenarioId)
  payload = {
    ...payload,
    manifest: {
      ...payload.manifest,
      scenarioId,
      scenarioSeed: payload.manifest.scenarioSeed || seed,
    },
  }

  onStage?.('done', '战役包生成完成。')
  return {
    payload,
    research,
    warnings,
    degraded: false,
  }
}

/**
 * 战役设计师 Agent（designer.ts）— 经 llm-service 走 IO。
 *
 * 输入：研究员产出的 ResearcherOutput（史实依据）+ 玩家需求。
 * 输出：符合七文件 schema 的 CampaignPayload 草案（map/factions/units/commanders/rules/victory）。
 *
 * 设计师输出即 CampaignPayload（七文件聚合），由 campaign-zip 的
 * validateCampaignPayload 做 ajv 严格校验。校验失败由 generator.ts 编排层
 * 反馈修正或降级模板包（绝不输出非法 payload）。
 *
 * @module layers/agents/generator/designer
 */

import type { LlmService } from '@/layers/application/services/llm-service'
import type {
  StreamChatOptions,
  StreamChatStats,
} from '@/layers/gateway/llm-client'
import type { LlmCallConfig } from '@/layers/agents/roles/llm-role-base'
import type { CampaignPayload } from '@/types'
import { stripMarkdownFence } from '@/layers/agents/protocol/schema'
import { buildGeneratorMessages } from './generator-schema'
import type { ResearcherOutput } from './generator-schema'

/** 设计师调用结果（payload 草案 + 原始文本 + 统计） */
export interface DesignerResult {
  /** 解析后的 CampaignPayload 草案（未校验，调用方负责 validateCampaignPayload） */
  payload: CampaignPayload
  /** LLM 原始输出文本（schema 失败反馈修正时附带） */
  rawText: string
  /** 流式统计 */
  stats: StreamChatStats
}

/**
 * 调设计师 Agent：ResearcherOutput → CampaignPayload 草案。
 *
 * 注意：此处仅做 JSON.parse（剥离 fence），**不做 ajv 校验**——校验由
 * generator.ts 调 validateCampaignPayload 统一执行，失败时把 errors 反馈设计师迭代。
 * JSON.parse 失败抛错，由编排层捕获走降级。
 *
 * @param llmService LLM 服务（注入，测试可 mock）
 * @param cfg LLM 调用配置
 * @param research 研究员产出
 * @param playerRequest 玩家原始需求（L3 附带，便于设计师把握基调）
 * @param previousErrors 上一轮 schema 校验错误（迭代修正时传入；首轮为空）
 */
export async function runDesigner(
  llmService: LlmService,
  cfg: LlmCallConfig,
  research: ResearcherOutput,
  playerRequest: string,
  previousErrors?: string,
): Promise<DesignerResult> {
  // L3 任务：研究员产出（JSON）+ 玩家需求 + 上一轮错误（迭代时）。
  // 固定 scenarioSeed 由编排层注入（确定性），设计师只产出结构。
  const researchJson = JSON.stringify(research)
  const taskParts = [
    '研究员产出（史实依据，JSON）：',
    researchJson,
    '',
    '玩家原始需求（L3）：',
    playerRequest,
    '',
    '请据此产出 CampaignPayload 七文件（严格 JSON）。manifest.scenarioSeed 留空字符串 ""，由系统注入固定种子。',
  ]
  if (previousErrors) {
    taskParts.push(
      '',
      '上一轮校验失败（请据此修正）：',
      previousErrors,
    )
  }
  const task = taskParts.join('\n')

  const messages = buildGeneratorMessages('designer', task)
  const opts: StreamChatOptions = {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
  }
  if (cfg.thinking) opts.thinking = cfg.thinking
  if (cfg.extraParams) opts.extraParams = cfg.extraParams

  // 设计师输出即 CampaignPayload：用 streamText 拿原文，自行 parse（不走 chief 等 schema）。
  const { text, stats } = await llmService.streamText(opts)

  let payload: CampaignPayload
  try {
    payload = JSON.parse(stripMarkdownFence(text)) as CampaignPayload
  } catch (e) {
    throw new Error(
      `设计师输出 JSON.parse 失败: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  return { payload, rawText: text, stats }
}

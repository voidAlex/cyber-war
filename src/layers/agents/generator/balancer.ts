/**
 * 平衡校验 Agent（balancer.ts）— 经 llm-service 走 IO。
 *
 * 输入：设计师产出的 CampaignPayload 草案 + 研究员产出（对照史实）。
 * 输出：BalancerOutput（pass/issues/suggestions）。
 *
 * 不通过（pass=false）时，generator.ts 把 issues/suggestions 反馈设计师迭代修正
 * （最多 N 次）。校验规则在共享 L0 前缀（HISTORY_CHECK_RULES + GENERATION_RULES）。
 *
 * @module layers/agents/generator/balancer
 */

import type { LlmService } from '@/layers/application/services/llm-service'
import type {
  StreamChatOptions,
  StreamChatStats,
} from '@/layers/gateway/llm-client'
import type { LlmCallConfig } from '@/layers/agents/roles/llm-role-base'
import type { CampaignPayload } from '@/types'
import { buildGeneratorMessages } from './generator-schema'
import {
  getGeneratorValidator,
  type BalancerOutput,
  type ResearcherOutput,
} from './generator-schema'

/**
 * 调平衡校验 Agent：payload 草案 → BalancerOutput。
 *
 * @param llmService LLM 服务（注入，测试可 mock）
 * @param cfg LLM 调用配置
 * @param payload 设计师产出的草案
 * @param research 研究员产出（对照史实合理性）
 */
export async function runBalancer(
  llmService: LlmService,
  cfg: LlmCallConfig,
  payload: CampaignPayload,
  research: ResearcherOutput,
): Promise<{ data: BalancerOutput; stats: StreamChatStats }> {
  const validate = getGeneratorValidator<BalancerOutput>('balancer')
  // L3 任务：草案 JSON + 史实对照。
  const task = [
    '待审战役包草案（CampaignPayload，JSON）：',
    JSON.stringify(payload),
    '',
    '研究员产出（史实对照，JSON）：',
    JSON.stringify(research),
    '',
    '请审查数值平衡、胜利条件可达、规模合理、双方公平，输出 pass/issues/suggestions。',
  ].join('\n')

  const messages = buildGeneratorMessages('balancer', task)
  const opts: StreamChatOptions = {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
  }
  if (cfg.thinking) opts.thinking = cfg.thinking
  if (cfg.extraParams) opts.extraParams = cfg.extraParams

  return llmService.streamChatStructured<BalancerOutput>(opts, validate)
}

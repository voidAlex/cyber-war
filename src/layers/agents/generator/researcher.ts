/**
 * 史实研究员 Agent（researcher.ts）— 经 llm-service 走 IO。
 *
 * 输入：玩家自然语言需求（战役名 / 时段地区 / 约束）。
 * 输出：结构化史实 ResearcherOutput（时间/双方/指挥官/地理/兵力/关键事件/胜负/存疑标注）。
 *
 * 史实来源策略（doc/tech-design-v1.0.md §3.11）：LLM 内置知识为主。
 * - 著名战役尽量准确；冷门/不确定事实标 facts.isUncertain=true（存疑）。
 * - 虚构/架空/自定义需求 historical=false（非史实），事实标存疑 + notes 注明「非史实」。
 *
 * @module layers/agents/generator/researcher
 */

import type { LlmService } from '@/layers/application/services/llm-service'
import type {
  StreamChatOptions,
  StreamChatStats,
} from '@/layers/gateway/llm-client'
import type { LlmCallConfig } from '@/layers/agents/roles/llm-role-base'
import { buildGeneratorMessages } from './generator-schema'
import {
  getGeneratorValidator,
  type ResearcherOutput,
} from './generator-schema'

/**
 * 调研究员 Agent：玩家需求 → ResearcherOutput。
 *
 * @param llmService LLM 服务（注入，测试可 mock）
 * @param cfg LLM 调用配置（provider/endpoint/model/apiKey）
 * @param playerRequest 玩家自然语言需求
 * @returns 结构化史实依据 + 流式统计
 */
export async function runResearcher(
  llmService: LlmService,
  cfg: LlmCallConfig,
  playerRequest: string,
): Promise<{ data: ResearcherOutput; stats: StreamChatStats }> {
  const validate = getGeneratorValidator<ResearcherOutput>('researcher')
  // L3 任务：玩家需求放尾部（缓存未命中是必然，但前缀 L0 三 Agent 共享可命中）。
  const task = `玩家需求（L3，请据此产出史实依据）：\n${playerRequest}`
  const messages = buildGeneratorMessages('researcher', task)

  const opts: StreamChatOptions = {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
  }
  if (cfg.thinking) opts.thinking = cfg.thinking
  if (cfg.extraParams) opts.extraParams = cfg.extraParams

  return llmService.streamChatStructured<ResearcherOutput>(opts, validate)
}

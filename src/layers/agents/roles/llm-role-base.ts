/**
 * LLM 角色调用基底（llm-role-base.ts）— 四类 Agent 共享的 LLM 调用辅助。
 *
 * 把"角色 → buildMessages → StreamChatOptions → streamChatStructured"的样板
 * 收拢一处，保证：
 * - prompt 分层（context-builder L0-L3）一致，缓存命中稳定。
 * - 校验函数由 getAgentValidator 预编译（schema.ts 缓存）。
 * - 错误一律 throw typed LlmCallError（绝不伪造），由编排层捕获走规则引擎兜底。
 *
 * 本模块为薄封装（非纯函数：经 LlmService 走 IO），供 roles 与 orchestrator 注入。
 *
 * @module layers/agents/roles/llm-role-base
 */

import type { ValidateFunction } from 'ajv'
import type { AgentRole, WorldState, AgentMessage } from '@/types'
import type { StreamChatOptions } from '@/layers/gateway/llm-client'
import { buildMessages } from '@/layers/agents/protocol/context-builder'
import type { LlmService } from '@/layers/application/services/llm-service'

/**
 * LLM 调用配置（从编排层注入，不读 session，保证可测性）。
 *
 * 含 provider/endpoint/model/apiKey 四件套（与 runtime-config 的 RuntimeLLMConfig 对齐）。
 * apiKey 即用即抛，经 llm-service 透传到 Rust，绝不在此缓存。
 */
export interface LlmCallConfig {
  /** provider 标识（deepseek/openai/anthropic/custom） */
  provider: StreamChatOptions['provider']
  /** 目标 endpoint URL */
  endpoint: string
  /** 模型名（如 deepseek-v4-flash / deepseek-v4-pro） */
  model: string
  /** API key（明文，即用即抛） */
  apiKey: string
  /** 可选思考模式（导演部/pro 用 thinking:{type:'enabled'}） */
  thinking?: Record<string, unknown>
  /** 可选额外参数（temperature 等） */
  extraParams?: Record<string, unknown>
}

/**
 * 构造 StreamChatOptions（messages 由 buildMessages 分层生成）。
 *
 * @param cfg LLM 调用配置
 * @param role Agent 角色
 * @param world 当前世界状态（L1+L2 来源）
 * @param task L3 本条具体任务文本
 * @param history 可选历史 messages（append-only）
 * @returns StreamChatOptions（含分层 messages + thinking/extraParams）
 */
export function buildLlmOptions(
  cfg: LlmCallConfig,
  role: AgentRole,
  world: WorldState,
  task: string,
  history?: AgentMessage[],
): StreamChatOptions {
  const messages = buildMessages(role, { worldState: world, task, history })
  const opts: StreamChatOptions = {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages,
  }
  if (cfg.thinking) opts.thinking = cfg.thinking
  if (cfg.extraParams) opts.extraParams = cfg.extraParams
  return opts
}

/**
 * 通用：调 LLM 获取结构化输出。
 *
 * 校验失败 / degraded / 四分类错误一律 throw typed error（上层兜底）。
 *
 * @param llmService LLM 服务（注入，测试可 mock）
 * @param cfg LLM 调用配置
 * @param role Agent 角色
 * @param validate ajv 校验函数（用 getAgentValidator 取得）
 * @param world 当前世界状态
 * @param task L3 任务文本
 * @param history 可选历史
 * @returns 解析后的强类型输出 + 流式统计
 */
export async function callStructured<T>(
  llmService: LlmService,
  cfg: LlmCallConfig,
  role: AgentRole,
  validate: ValidateFunction<T>,
  world: WorldState,
  task: string,
  history?: AgentMessage[],
): Promise<{ data: T; stats: import('@/layers/gateway/llm-client').StreamChatStats }> {
  const opts = buildLlmOptions(cfg, role, world, task, history)
  return llmService.streamChatStructured<T>(opts, validate)
}

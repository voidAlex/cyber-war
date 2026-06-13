/**
 * Agent 层 barrel（protocol + roles + orchestrator + director）。
 *
 * protocol 为纯函数边界；roles/orchestrator/director 涉及 LLM 调用
 * 但经 services/llm-service + gateway/llm-client 间接走 Rust，不直接 import @tauri-apps/api。
 *
 * @module layers/agents
 */

export * from './protocol'
export * from './roles'
export * from './orchestrator'
export * from './director'

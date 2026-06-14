/**
 * 生成器 barrel（generator/）。
 *
 * 内置战役生成器 Agent 编排（doc/tech-design-v1.0.md §3.11）：
 * - prefix：三 Agent 共享 L0 前缀（七文件 schema/生成规则/历史校验规则），缓存命中。
 * - generator-schema：researcher/balancer 输出 schema + messages 构造（纯函数）。
 * - researcher/designer/balancer：三 Agent 角色（经 llm-service 走 IO）。
 * - template-fallback：schema 多次失败降级模板包（纯函数）。
 * - generator：编排入口 generateCampaign。
 *
 * @module layers/agents/generator
 */

export * from './prefix'
export * from './shared-text'
export * from './generator-schema'
export * from './researcher'
export * from './designer'
export * from './balancer'
export * from './template-fallback'
export * from './generator'

/**
 * 生成器共享 L0 前缀（prefix.ts）— 纯函数边界。
 *
 * 对应 doc/tech-design-v1.0.md §3.11「缓存优化」：生成器 prompt 的
 * 「七文件 schema 定义 + 生成规则 + 历史校验规则」是**固定 L0 前缀**，
 * researcher / designer / balancer 三个 Agent 共享该前缀 → 高缓存命中
 * （吃满 DeepSeek 硬盘 KV 缓存红利）。玩家需求放 L3 尾部。
 *
 * 强制规则（与 context-builder L0 一致）：
 * - 本模块所有字符串常量**严格固定**，禁注入时间戳/UUID/玩家需求等易变内容。
 * - 这些内容会被 JSON.stringify 拼成稳定 system 消息，跨请求字节级一致。
 *
 * 本模块为纯函数：不调 Tauri/fetch/crypto/Date.now/random。
 *
 * @module layers/agents/generator/prefix
 */

import type { AgentMessage } from '@/types'
import {
  CAMPAIGN_SCHEMA_SUMMARY,
  GENERATION_RULES,
  HISTORY_CHECK_RULES,
} from './shared-text'

// =============================================================================
// 三 Agent 的 L0 人格 system prompt（固定）
// =============================================================================

/** 史实研究员（researcher）人格与职责（L0 固定） */
const RESEARCHER_SYSTEM_PROMPT = [
  '你是战役生成器的史实研究员（History Researcher）。',
  '职责：根据玩家的自然语言需求，基于你的内置历史知识，输出结构化史实依据。',
  '原则：',
  '- 以内置知识为主，不虚构具体数字；冷门或不确定的事实标 isUncertain:true（存疑）。',
  '- 若玩家需求为虚构/架空/自定义（非真实战役），把 historical:false 写在元信息，',
  '  并把阵营/地理/兵力按需求合理推断，事实字段标 isUncertain:true。',
  '- 真实战役 historical:true，并尽量给出指挥官的人格倾向、双方阵营、地理节点、兵力规模、关键事件、胜负。',
  '- 不输出 JSON 以外的解释文本。',
  '输出格式：严格 JSON，schema 见「研究员输出 schema」。玩家需求见 L3 末尾。',
].join('\n')

/** 战役设计师（designer）人格与职责（L0 固定） */
const DESIGNER_SYSTEM_PROMPT = [
  '你是战役生成器的战役设计师（Campaign Designer）。',
  '职责：把研究员产出的史实依据，转换为符合七文件 schema 的可玩战役包草案（CampaignPayload）。',
  '原则：',
  '- 七文件字段必须全部满足 schema 约束（数值范围/枚举/必填），引用 id 必须自洽（commanderId 存在于 commanders，nodeId 存在于 highValueNodes 等）。',
  '- 地图须含地形/高价值节点；units 按史实部署且坐标落在地图范围内。',
  '- commanders 含人格数值（aggression/obedience 0..1，preferredTempo 枚举）。',
  '- rules 数值在 schema 区间内；victory 条件可达且双方公平（各至少 1 条胜利条件）。',
  '- 不输出 JSON 以外的解释文本。',
  '输出格式：严格 JSON，schema 见「七文件 schema 定义」与「生成规则」。',
].join('\n')

/** 平衡校验（balancer）人格与职责（L0 固定） */
const BALANCER_SYSTEM_PROMPT = [
  '你是战役生成器的平衡校验员（Balance Reviewer）。',
  '职责：审查设计师产出的战役包草案，检查数值平衡、胜利条件可达、规模合理、双方公平。',
  '原则：',
  '- 不修改草案内容，只输出 review：pass:boolean、issues[]、suggestions[]。',
  '- issues 给出具体字段路径与问题描述；suggestions 给出可执行修正建议。',
  '- 双方应各至少有 1 条可达成胜利条件；兵力差距不应悬殊到一方无胜算。',
  '- 不输出 JSON 以外的解释文本。',
  '输出格式：严格 JSON，schema 见「平衡校验输出 schema」。',
].join('\n')

/** 三 Agent 的 L0 人格（角色名 → system 文本） */
export const GENERATOR_ROLE_PROMPTS = {
  researcher: RESEARCHER_SYSTEM_PROMPT,
  designer: DESIGNER_SYSTEM_PROMPT,
  balancer: BALANCER_SYSTEM_PROMPT,
} as const

/** 生成器 Agent 角色名（区别于主游戏 AgentRole，独立枚举） */
export type GeneratorRole = keyof typeof GENERATOR_ROLE_PROMPTS

// =============================================================================
// 三 Agent 共享的 L0「七文件 schema 定义 + 生成规则 + 历史校验规则」
// =============================================================================
//
// 这三段文本由 shared-text.ts 集中定义（常量），此处 JSON.stringify 为稳定 system 消息。
// 三 Agent 共享同一份 → DeepSeek 缓存前缀命中（researcher 命中后 designer/balancer 也命中）。

/** 七文件 schema 定义段（L0 共享，固定） */
export const SCHEMA_DEFINITION_MESSAGE: AgentMessage = {
  role: 'system',
  content: `七文件 schema 定义（生成器与设计师共用，固定不变）：\n${CAMPAIGN_SCHEMA_SUMMARY}`,
}

/** 生成规则段（L0 共享，固定） */
export const GENERATION_RULES_MESSAGE: AgentMessage = {
  role: 'system',
  content: `生成规则（固定不变）：\n${GENERATION_RULES}`,
}

/** 历史校验规则段（L0 共享，固定） */
export const HISTORY_CHECK_RULES_MESSAGE: AgentMessage = {
  role: 'system',
  content: `历史校验规则（固定不变）：\n${HISTORY_CHECK_RULES}`,
}

/**
 * 构造某 Agent 角色的 L0 前缀 messages（人格 + 共享三段）。
 *
 * 顺序固定：[人格] [七文件 schema] [生成规则] [历史校验规则]，
 * 三 Agent 的后三段完全一致 → 跨 Agent 缓存命中。
 *
 * @param role 生成器 Agent 角色
 * @returns L0 固定 messages（4 条）
 */
export function buildGeneratorL0(role: GeneratorRole): AgentMessage[] {
  return [
    { role: 'system', content: GENERATOR_ROLE_PROMPTS[role] },
    SCHEMA_DEFINITION_MESSAGE,
    GENERATION_RULES_MESSAGE,
    HISTORY_CHECK_RULES_MESSAGE,
  ]
}

/**
 * 估算生成器 messages 的 L0 前缀字符数（供 Inspector 诊断缓存分层）。
 * 纯函数：仅基于已固定的 L0 常量统计。
 */
export function generatorL0CharCount(): number {
  const all = buildGeneratorL0('researcher')
  return all.reduce((sum, m) => sum + m.content.length, 0)
}

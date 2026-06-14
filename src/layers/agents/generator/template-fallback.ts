/**
 * 生成器降级模板包（template-fallback.ts）— 纯函数。
 *
 * 当 designer 多次 schema 校验失败、或 balancer 始终不通过时，generator 降级为
 * 基于 verdun 结构填充的模板包（**绝不输出非法 payload**）。
 *
 * 模板策略：以凡尔登七文件为骨架（已 schema 校验合法），把 scenarioId/displayName/
 * 指挥官名等替换为研究员产出的占位信息。模板包**明确标注「非史实·降级生成」**，
 * 玩家可在 UI 看到 warnings 后决定是否导入。
 *
 * 纯函数：不调 IO，仅基于研究员产出 + verdun 骨架做填充。
 *
 * @module layers/agents/generator/template-fallback
 */

import type {
  CampaignPayload,
  CampaignManifest,
} from '@/types'
import { CAMPAIGN_SCHEMA_VERSION } from '@/types'
import {
  verdunMap,
  verdunFactions,
  verdunUnits,
  verdunCommanders,
  verdunRules,
  verdunVictory,
} from '@/data/verdun-1916'
import type { ResearcherOutput } from './generator-schema'

/**
 * 生成固定 scenarioSeed（确定性）。
 *
 * 生成时确定（非每次调用变化）：基于玩家需求 + 研究员战役名做稳定 hash。
 * 产物固化即可回放（生成过程允许非确定，但 seed 固定）。
 *
 * @param playerRequest 玩家原始需求
 * @param scenarioId 场景 id
 */
export function makeScenarioSeed(playerRequest: string, scenarioId: string): string {
  // 简单稳定 hash（djb2 变体），仅做确定性基底，非密码学用途。
  const input = `${scenarioId}:${playerRequest}`
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  // 转无符号 32 位 hex
  const unsigned = hash >>> 0
  return `${scenarioId}:${unsigned.toString(16).padStart(8, '0')}`
}

/**
 * 把研究员产出的战役名转为合法 scenarioId（小写字母数字连字符）。
 */
export function toScenarioId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // 确保首字符是字母数字（schema pattern ^[a-z0-9][a-z0-9-]*$）
  const safe = base.length > 0 ? base : 'generated'
  return /^[a-z0-9]/.test(safe) ? safe : `gen-${safe}`
}

/**
 * 构造降级模板包（基于 verdun 骨架填充）。
 *
 * 模板包与凡尔登结构同构（已 schema 合法），仅替换：
 * - manifest.scenarioId/displayName/scenarioSeed/description
 * - 标注「非史实·降级生成」（historical=false 时）或保留史实说明
 *
 * 注意：factions/units/commanders/map/rules/victory **直接复用 verdun 合法结构**，
 * 保证 schema 一定通过。玩家若不满意可重新生成。
 *
 * @param research 研究员产出（提供战役名/史实/非史实标记）
 * @param playerRequest 玩家原始需求（用于 seed）
 * @returns 校验合法的模板包 payload + 警告列表
 */
export function buildTemplateFallback(
  research: ResearcherOutput,
  playerRequest: string,
): { payload: CampaignPayload; warnings: string[] } {
  const scenarioId = toScenarioId(research.name)
  const scenarioSeed = makeScenarioSeed(playerRequest, scenarioId)

  const historicalLabel = research.historical ? '史实' : '非史实·虚构'

  const manifest: CampaignManifest = {
    scenarioId,
    displayName: `${research.name}（${historicalLabel}·降级模板）`,
    scenarioSeed,
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    playerFactionIds: verdunFactions.map((f) => f.id),
    description:
      `基于「${research.name}」降级生成的模板战役包（${historicalLabel}）。` +
      `因 LLM 生成多次未通过 schema 校验，已回退到模板结构（地图/阵营/单位沿用凡尔登骨架）。` +
      `研究员备注：${research.notes}`,
    startInGameDate: '1916-02-21',
    maxTurns: 30,
  }

  const warnings = [
    `降级生成：LLM 多次未通过 schema 校验，已回退模板包（${historicalLabel}）。`,
    `模板包地图/阵营/单位沿用凡尔登结构，可能与「${research.name}」史实不符，建议重新生成。`,
    `研究员存疑事实：${research.facts
      .filter((f) => f.isUncertain)
      .map((f) => f.claim)
      .slice(0, 3)
      .join('；') || '无'}`,
  ]

  return {
    payload: {
      manifest,
      map: verdunMap,
      factions: verdunFactions,
      units: verdunUnits,
      commanders: verdunCommanders,
      rules: verdunRules,
      victory: verdunVictory,
    },
    warnings,
  }
}

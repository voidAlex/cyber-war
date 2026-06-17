/**
 * 内置战役包注册表（registry.ts）— UI 开局流程的单一数据来源。
 *
 * 职责：
 * - 集中登记所有随产品分发的内置战役包（凡尔登/官渡/俄乌/中途岛/美以伊）。
 * - 暴露 BUILTIN_CAMPAIGNS 列表（含 scenarioId/name/payload/playerFactionOptions），
 *   供 TitleScreen / CampaignPanel 渲染战役选择列表。
 * - 暴露按 scenarioId 查 manifest 的辅助（供 App.tsx Header 时间推算）。
 * - 暴露按 scenarioId 查 rules 的辅助（供 store/orchestrator 注册随机事件/AI 角色）。
 *
 * 设计说明：
 * - 此处仅聚合（再 export），不在数据层重复定义 manifest/rules/units（DRY）。
 * - playerFactionOptions 直接派生自 manifest.playerFactionIds + factions 表，
 *   不写死中文标签（标签 = faction.name，与剧本数据保持单一来源）。
 *
 * @module data/registry
 */

import type { CampaignPayload, CampaignManifest, CampaignRules } from '@/types'
import { verdunCampaign, verdunManifest, verdunRules } from './verdun-1916'
import { guanduCampaign, guanduManifest, guanduRules } from './guandu-200'
import { ukraineCampaign, ukraineManifest, ukraineRules } from './ukraine-2022'
import { midwayCampaign, midwayManifest, midwayRules } from './midway-1942'
import { iranCampaign, iranManifest, iranRules } from './iran-2026'

/**
 * 单个内置战役包在 UI 列表中的呈现项。
 *
 * - scenarioId：剧本 id（同时是存档 scenarioId）。
 * - name：人类可读名（来自 manifest.displayName，标题屏列表展示）。
 * - description：战役背景描述（来自 manifest.description）。
 * - payload：可加载的七文件聚合（开局流程直接传入 startCampaignFromPayload）。
 * - playerFactionOptions：玩家可选阵营（id + 显示名 + 一句话简介），动态从
 *   manifest.playerFactionIds + payload.factions 派生。
 */
export interface BuiltinCampaignEntry {
  scenarioId: string
  name: string
  description: string
  payload: CampaignPayload
  playerFactionOptions: { id: string; name: string; description: string }[]
}

/**
 * 把 CampaignPayload 派生为玩家可选阵营选项列表（按 manifest.playerFactionIds 顺序）。
 *
 * @param payload 七文件聚合
 * @returns 玩家可选阵营选项（id + name + description）
 */
function deriveFactionOptions(
  payload: CampaignPayload,
): { id: string; name: string; description: string }[] {
  const factionById = new Map(payload.factions.map((f) => [f.id, f]))
  return payload.manifest.playerFactionIds.map((fid) => {
    const f = factionById.get(fid)
    return {
      id: fid,
      name: f?.name ?? fid,
      description: f?.description ?? '',
    }
  })
}

/**
 * 内置战役包注册表（按开局流程展示顺序：凡尔登 → 官渡 → 俄乌 → 中途岛 → 美以伊）。
 *
 * 标题屏「内置/导入战役」列表渲染此数组；玩家选包 + 阵营 → startCampaignFromPayload。
 */
export const BUILTIN_CAMPAIGNS: BuiltinCampaignEntry[] = [
  {
    scenarioId: verdunManifest.scenarioId,
    name: verdunManifest.displayName,
    description: verdunManifest.description ?? '',
    payload: verdunCampaign,
    playerFactionOptions: deriveFactionOptions(verdunCampaign),
  },
  {
    scenarioId: guanduManifest.scenarioId,
    name: guanduManifest.displayName,
    description: guanduManifest.description ?? '',
    payload: guanduCampaign,
    playerFactionOptions: deriveFactionOptions(guanduCampaign),
  },
  {
    scenarioId: ukraineManifest.scenarioId,
    name: ukraineManifest.displayName,
    description: ukraineManifest.description ?? '',
    payload: ukraineCampaign,
    playerFactionOptions: deriveFactionOptions(ukraineCampaign),
  },
  {
    scenarioId: midwayManifest.scenarioId,
    name: midwayManifest.displayName,
    description: midwayManifest.description ?? '',
    payload: midwayCampaign,
    playerFactionOptions: deriveFactionOptions(midwayCampaign),
  },
  {
    scenarioId: iranManifest.scenarioId,
    name: iranManifest.displayName,
    description: iranManifest.description ?? '',
    payload: iranCampaign,
    playerFactionOptions: deriveFactionOptions(iranCampaign),
  },
]

/**
 * 按 scenarioId 查内置战役条目（payload + 阵营选项）。
 *
 * @param scenarioId 剧本 id
 * @returns 内置战役条目或 undefined（未注册）
 */
export function getBuiltinCampaign(
  scenarioId: string,
): BuiltinCampaignEntry | undefined {
  return BUILTIN_CAMPAIGNS.find((c) => c.scenarioId === scenarioId)
}

/**
 * 按 scenarioId 查内置战役 manifest（供 App.tsx Header 时间推算 startInGameDate/daysPerTurn）。
 *
 * @param scenarioId 剧本 id
 * @returns manifest 或 undefined
 */
export function getBuiltinManifest(
  scenarioId: string,
): CampaignManifest | undefined {
  return getBuiltinCampaign(scenarioId)?.payload.manifest
}

/**
 * 按 scenarioId 查内置战役 rules（供 store/orchestrator 注册随机事件/AI 角色）。
 *
 * @param scenarioId 剧本 id
 * @returns rules 或 undefined
 */
export function getBuiltinRules(
  scenarioId: string,
): CampaignRules | undefined {
  return getBuiltinCampaign(scenarioId)?.payload.rules
}

/**
 * 内置战役 manifest 全量映射（scenarioId → CampaignManifest）。
 *
 * 与 BUILTIN_CAMPAIGN_RULES 同源，供需要按 id 批量查 manifest 的场景（如 Header 时间）。
 */
export const BUILTIN_MANIFESTS_BY_ID: Record<string, CampaignManifest> =
  Object.fromEntries(
    BUILTIN_CAMPAIGNS.map((c) => [c.scenarioId, c.payload.manifest]),
  )

/**
 * 内置战役 rules 全量映射（scenarioId → CampaignRules）。
 *
 * 替代 store 内硬编码凡尔登的 BUILTIN_CAMPAIGN_RULES。供编排器按 scenarioId
 * 查 rules（随机事件、AI 角色等）。
 */
export const BUILTIN_CAMPAIGN_RULES: Record<string, CampaignRules> =
  Object.fromEntries(
    BUILTIN_CAMPAIGNS.map((c) => [c.scenarioId, c.payload.rules]),
  )

// 兜底引用以保留旧 import 路径（verdunRules 等仍可被单独 import；同时若未来从
// 旧位置迁出，本注册表是单一聚合入口）。
void verdunRules
void guanduRules
void ukraineRules
void midwayRules
void iranRules

/**
 * 开场参谋长简报弹窗（OpeningBriefing.tsx）— 第 5 批新战役开场叙事。
 *
 * 职责（任务 B 开场参谋长简报弹窗）：
 * - 新战役加载后（context 刚写入，turn=0，phase=idle），App.tsx 据
 *   store.showOpeningBriefing === true 渲染本组件（全屏叠加）。
 * - 以参谋长身份向玩家做战前简报，分四段：
 *   · 背景（background）：战役背景叙事（基于 manifest.displayName/description）。
 *   · 处境（situation）：当前战场态势（敌方位置/兵力优势/威胁方向，来自 factions）。
 *   · 状态（status）：我方部署（单位数/兵力/强弱点，来自 units）。
 *   · 目标（objectives）：胜利条件（来自 victory.conditions）。
 * - 玩家阅读后点「开始指挥」关闭弹窗（store.dismissOpeningBriefing），进入正常游戏。
 *
 * 文本来源（双路，确保离线可用）：
 * - 优先 LLM：调 chief.chat("请做战前简报...") → 参谋长生成沉浸式简报。
 * - 降级 mock：buildMockBriefing 基于真实 manifest/world/victory 数据生成模板文本。
 *
 * 设计说明：
 * - mock 文本不伪造数据：背景=manifest.description，处境=敌方阵营名+兵力，
 *   状态=我方单位数+总兵力+士气均值，目标=victory.conditions.description（我方阵营）。
 * - 赛博朋克风格（深空蓝底 + 青光描边 + 扫描线）。
 * - LLM 失败/超时不阻塞：2s timeout + try/catch 走 mock。
 *
 * @module layers/ui/briefing/OpeningBriefing
 */

import { useEffect, useMemo, useState, type JSX } from 'react'
import { useGameStore, buildLlmCallConfig } from '@/store/game-store'
import { llmService } from '@/layers/application/services/llm-service'
import { createLlmChiefRole } from '@/layers/agents/roles'
import type { ChiefChatResult } from '@/layers/agents/roles/chief'
import { getPlayerFactionId } from '@/layers/ui/sandbox/intel-visibility'
import type { WorldState, CampaignFaction, CampaignUnit } from '@/types'
import { getBuiltinCampaign } from '@/data/registry'
import { logger } from '@/utils/logger'

/** 简报四段文本结构 */
interface BriefingText {
  /** 背景（战役叙事） */
  background: string
  /** 处境（敌方态势） */
  situation: string
  /** 状态（我方部署） */
  status: string
  /** 目标（胜利条件） */
  objectives: string
}

/**
 * 开场参谋长简报弹窗组件。
 *
 * @param onDismiss 玩家点击「开始指挥」时调用（store.dismissOpeningBriefing）
 */
export default function OpeningBriefing({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const context = useGameStore((s) => s.context)

  // mock 简报文本：渲染期同步计算（基于真实 world 数据），作为离线兜底。
  // 用 useMemo 避免每次渲染重算；context 变化时重算。
  const mockText = useMemo<BriefingText | null>(() => {
    if (context === null) return null
    return buildMockBriefing(context.game.world)
  }, [context])

  // LLM 简报结果（仅 LLM 成功后填充；未到达/失败/未配置 LLM 时为 null）。
  // 不在 render 期 setState；仅由 effect 的异步回调 set（符合 react-hooks 规则）。
  const [llmBriefing, setLlmBriefing] = useState<BriefingText | null>(null)

  // 异步加载 LLM 简报：优先 LLM，失败/超时保留 mock。
  // 仅在异步回调内 setState（符合 react-hooks/set-state-in-effect 规则）。
  const currentMock = mockText
  useEffect(() => {
    if (context === null || currentMock === null) return
    const world = context.game.world
    const llmConfig = buildLlmCallConfig()
    if (llmConfig === null) {
      // 未配 LLM：直接用 mock，不尝试 LLM。
      return
    }
    // 2s 超时：LLM 太慢则放弃，保留 mock（避免开场卡顿）。
    let cancelled = false
    const timeoutId = window.setTimeout(() => {
      cancelled = true
      logger.info('ui/briefing/opening/llm_timeout', 'LLM 简报超时，使用 mock', {
        scope: 'app',
        saveId: world.saveId,
      })
    }, 2000)

    void (async (): Promise<void> => {
      try {
        const role = createLlmChiefRole(llmService, llmConfig)
        const playerFactionId = getPlayerFactionId(world.factions, world.playerFactionId)
        const prompt = buildChiefPrompt(world)
        const result: ChiefChatResult = await role.chat(
          prompt,
          { world, playerFactionId },
          [], // 无历史（开场）
        )
        if (cancelled) return
        // 把 LLM 文本拆分为四段（按标记）；解析失败则整体放入 background。
        const parsed = parseLlmBriefing(result.text, currentMock)
        window.clearTimeout(timeoutId)
        // 异步回调内 setState（规则允许）。
        setLlmBriefing(parsed)
      } catch (err) {
        window.clearTimeout(timeoutId)
        logger.warn('ui/briefing/opening/llm_failed', `LLM 简报失败，使用 mock: ${String(err)}`, {
          scope: 'app',
          saveId: world.saveId,
        })
        // 保留 mock 兜底（不 set）。
      }
    })()

    return () => {
      window.clearTimeout(timeoutId)
      cancelled = true
    }
  }, [context, currentMock])

  if (context === null || mockText === null) {
    // 防御：context 丢失时直接关闭（不应发生）。
    return <></>
  }

  const world = context.game.world
  const manifestName = getBuiltinCampaign(world.scenarioId)?.name ?? world.scenarioId
  // 当前展示文本：LLM 结果优先（若已到达），否则 mock 兜底。
  const displayText = llmBriefing ?? mockText
  // 来源标签：有 LLM 结果显示「LLM 生成」，否则「离线模板」。
  const source: 'mock' | 'llm' = llmBriefing !== null ? 'llm' : 'mock'

  return (
    <div
      className="opening-briefing"
      role="dialog"
      aria-modal="true"
      aria-labelledby="opening-briefing-title"
    >
      <div className="opening-briefing__bg" aria-hidden="true" />
      <div className="opening-briefing__card">
        {/* 标题（Orbitron + 数据标签样式） */}
        <header className="opening-briefing__header">
          <span className="opening-briefing__tag">▌ CHIEF OF STAFF ▌</span>
          <h2 id="opening-briefing-title" className="opening-briefing__title">
            参谋长战前简报
          </h2>
          <p className="opening-briefing__scenario">{manifestName}</p>
        </header>

        {/* 四段文本（mock 兜底即时显示；LLM 到达后替换） */}
        <div className="opening-briefing__body">
          <>
            <BriefingSection label="背景" text={displayText.background} />
            <BriefingSection label="处境" text={displayText.situation} />
            <BriefingSection label="状态" text={displayText.status} />
            <BriefingSection label="目标" text={displayText.objectives} />
          </>
        </div>

        {/* 底部行动 */}
        <footer className="opening-briefing__footer">
          <span className="opening-briefing__source">
            {source === 'llm' ? 'LLM 生成' : '离线模板'}
          </span>
          <button
            type="button"
            className="opening-briefing__btn"
            onClick={onDismiss}
          >
            ▶ 开始指挥
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 简报单段（数据标签 + 正文）。 */
function BriefingSection({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <section className="opening-briefing__section">
      <h3 className="opening-briefing__section-label">
        <span className="opening-briefing__section-bracket">[</span>
        {label}
        <span className="opening-briefing__section-bracket">]</span>
      </h3>
      <p className="opening-briefing__section-text">{text}</p>
    </section>
  )
}

// =============================================================================
// mock 简报生成（基于真实 manifest/world/victory 数据，不伪造）
// =============================================================================

/**
 * 从内置注册表或 ZIP 导入包查 playerFaction 对应的战役数据视图（factions/units/victory）。
 *
 * 内置包：从 registry 取 payload.factions/units/victory。
 * 导入包：world.factions/units 已是 runtime 投影（side 已 swap），victory 从 registry 取
 *         （导入包未注册到 registry 时 victory 缺失，简报目标段降级为通用文案）。
 *
 * @param world 当前世界状态（runtime 投影后）
 * @returns 战役数据视图（factions/units 可能来自内置 payload 或 runtime world）
 */
function getCampaignDataView(world: WorldState): {
  factions: ReadonlyArray<CampaignFaction | WorldState['factions'][number]>
  units: ReadonlyArray<CampaignUnit | WorldState['units'][number]>
  victory?: import('@/types').CampaignVictory
} {
  const builtin = getBuiltinCampaign(world.scenarioId)
  if (builtin) {
    return {
      factions: builtin.payload.factions,
      units: builtin.payload.units,
      victory: builtin.payload.victory,
    }
  }
  // 导入包（未注册到 registry）：用 runtime world 数据；victory 不可用。
  return { factions: world.factions, units: world.units, victory: undefined }
}

/**
 * 生成 mock 简报文本（四段，基于真实数据）。
 *
 * - 背景：manifest.description（战役包作者撰写的史实/设定）。
 * - 处境：敌方阵营名 + 兵力（units 总 personnel）+ 威胁方向（doctrineTags）。
 * - 状态：我方单位数 + 总兵力 + 士气均值 + 学说。
 * - 目标：victory.conditions 中 factionId===我方 的描述；缺失时通用文案。
 *
 * @param world 当前世界状态
 */
function buildMockBriefing(world: WorldState): BriefingText {
  const playerFactionId = getPlayerFactionId(world.factions, world.playerFactionId)
  const view = getCampaignDataView(world)

  // 阵营查找（runtime world.factions，side 已 swap；payload factions 仍是剧本 side）
  const playerFaction = world.factions.find((f) => f.id === playerFactionId)
  const enemyFactions = world.factions.filter(
    (f) => f.id !== playerFactionId && (f.side === 'enemy'),
  )

  // 单位统计（按阵营）
  const myUnits = world.units.filter((u) => u.factionId === playerFactionId)
  const enemyUnits = world.units.filter((u) => enemyFactions.some((f) => f.id === u.factionId))
  const myPersonnel = myUnits.reduce((sum, u) => sum + u.personnel, 0)
  const enemyPersonnel = enemyUnits.reduce((sum, u) => sum + u.personnel, 0)
  const myMoraleAvg = myUnits.length > 0
    ? Math.round(myUnits.reduce((s, u) => s + u.morale, 0) / myUnits.length)
    : 0

  // —— 背景 ——
  const builtin = getBuiltinCampaign(world.scenarioId)
  const description = builtin?.description ?? playerFaction?.description ?? ''
  const playerName = playerFaction?.name ?? playerFactionId
  const background = description.length > 0
    ? `${description}`
    : `${playerName}，战役已开局。当前为第 0 回合，战前态势如下。`

  // —— 处境 ——
  const enemyNames = enemyFactions.map((f) => f.name).join('、') || '未知敌军'
  const enemyDoctrine = enemyFactions
    .flatMap((f) => f.doctrineTags)
    .slice(0, 3)
    .join('、')
  const situation =
    `当前主要对手为${enemyNames}。` +
    `敌方可投入兵力约 ${formatPersonnel(enemyPersonnel)}（${enemyUnits.length} 个建制单位），` +
    `我方约 ${formatPersonnel(myPersonnel)}（${myUnits.length} 个建制单位）。` +
    (enemyDoctrine.length > 0 ? `敌方作战风格：${enemyDoctrine}。` : '') +
    (enemyPersonnel > myPersonnel
      ? '敌军兵力占优，需依托地形与防御工事消耗其锐气。'
      : myPersonnel > enemyPersonnel
        ? '我军兵力占优，可寻机决战。'
        : '双方兵力相当，胜负取决于指挥与补给。')

  // —— 状态 ——
  const myDoctrine = playerFaction?.doctrineTags.slice(0, 3).join('、') ?? ''
  const status =
    `我方（${playerName}）现有 ${myUnits.length} 个建制单位，总兵力约 ${formatPersonnel(myPersonnel)}，` +
    `平均士气 ${myMoraleAvg}。` +
    (myDoctrine.length > 0 ? `作战学说：${myDoctrine}。` : '') +
    '各单位已按剧本初始部署就位，补给线（若配置）已建立。'

  // —— 目标 ——
  const myVictoryConds = view.victory
    ? view.victory.conditions.filter((c) => c.factionId === playerFactionId)
    : []
  let objectives: string
  if (myVictoryConds.length > 0) {
    objectives =
      '本次战役我方胜利条件：\n' +
      myVictoryConds.map((c) => `· ${c.description}`).join('\n')
  } else {
    objectives = '完成剧本设定的胜利目标（详见战报与高价值节点）。坚守或歼敌，任一达成即胜。'
  }

  return { background, situation, status, objectives }
}

/** 把 personnel 数格式化为「X 万」「X 千」「X」中文形式。 */
function formatPersonnel(n: number): string {
  if (n >= 10000) {
    return `${(n / 10000).toFixed(1)} 万`
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)} 千`
  }
  return `${n}`
}

// =============================================================================
// LLM 简报（chief.chat）
// =============================================================================

/**
 * 构造参谋长简报请求 prompt。
 *
 * 指示参谋长以战前简报格式产出四段（背景/处境/状态/目标），基于真实 world 数据。
 *
 * @param world 当前世界状态
 */
function buildChiefPrompt(world: WorldState): string {
  return (
    '请以参谋长身份做一次战前简报，分为四段：背景、处境、状态、目标。' +
    '每段以「【背景】」「【处境】」「【状态】」「【目标】」开头，' +
    '内容基于当前真实战场数据（敌方兵力、我方部署、胜利条件），不要伪造数据。' +
    `当前剧本：${world.scenarioId}。`
  )
}

/** LLM 标记 → 字段名映射 */
const LLN_SECTION_MARKERS: Array<{ marker: string; field: keyof BriefingText }> = [
  { marker: '【背景】', field: 'background' },
  { marker: '【处境】', field: 'situation' },
  { marker: '【状态】', field: 'status' },
  { marker: '【目标】', field: 'objectives' },
]

/**
 * 解析 LLM 简报文本为四段结构。
 *
 * 按「【背景】」等标记切分；解析失败（缺标记）时整体放入 background，其余用 mock 兜底。
 *
 * @param text LLM 原始回复
 * @param mockText mock 兜底文本（解析失败段用对应 mock 段填充）
 */
function parseLlmBriefing(text: string, mockText: BriefingText): BriefingText {
  const result: BriefingText = { ...mockText }
  // 找各标记位置
  const positions = LLN_SECTION_MARKERS.map((m) => ({
    field: m.field,
    marker: m.marker,
    index: text.indexOf(m.marker),
  })).filter((p) => p.index >= 0)

  if (positions.length === 0) {
    // 无任何标记：整体作为 background
    result.background = text.trim()
    return result
  }

  // 按出现顺序排序，每段从标记后到下一标记前
  positions.sort((a, b) => a.index - b.index)
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i]
    const startIdx = cur.index + cur.marker.length
    const endIdx = i + 1 < positions.length ? positions[i + 1].index : text.length
    const segment = text.slice(startIdx, endIdx).trim()
    if (segment.length > 0) {
      result[cur.field] = segment
    }
  }
  return result
}

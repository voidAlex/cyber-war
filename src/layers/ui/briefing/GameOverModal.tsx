/**
 * 胜负终局弹窗（GameOverModal.tsx）— 第 6 批战役终局展示。
 *
 * 职责（任务 B 胜利/失败弹窗）：
 * - advanceTurn 结算后若 world.victoryState !== 'ongoing'，store.showGameOver=true，
 *   App.tsx 据此渲染本组件（全屏叠加，最高优先级，覆盖一切其他弹窗）。
 * - 全屏赛博朋克 modal：
 *   · 胜利（won）= 金色辉光标题「战役胜利」。
 *   · 失败（lost）= 红色辉光标题「战役失败」。
 *   · 平局（draw）= 灰色标题「战役结束」。
 * - 内容：战役名称 + 总回合数 + 胜利条件达成摘要 + 最终战损统计（己方/敌方
 *   剩余兵力/总损失）+ 导演部总结叙事（mock 模板兜底，LLM 失败不阻塞）。
 * - 按钮：
 *   · 「返回标题屏」→ context=null 回标题屏（与 handleExit 一致）。
 *   · 「查看沙盘」→ 关闭弹窗但仍留游戏界面（dismissGameOver），玩家可看最终态势。
 *
 * 数据来源（不伪造）：
 * - 战役名：getBuiltinCampaign(world.scenarioId)?.name ?? scenarioId。
 * - 总回合数：world.turnIndex（0 起，UI 显示 +1）。
 * - 胜利条件摘要：world.victoryReason（checkVictory.reason）+ 玩家阵营胜利条件文本。
 * - 最终战损：world.units 实时统计（剩余 personnel）+ world.accumulatedCasualties
 *   （累计 strength 损失）。
 * - 导演部叙事：buildMockNarrative 基于真实 world 数据生成模板文本（LLM 失败兜底）。
 *
 * @module layers/ui/briefing/GameOverModal
 */

import { useEffect, useMemo, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { getPlayerFactionId } from '@/layers/ui/sandbox/intel-visibility'
import { getBuiltinCampaign } from '@/data/registry'
import type { WorldState, Faction } from '@/types'
import { logger } from '@/utils/logger'

/**
 * GameOverModal 组件。
 *
 * 由 App.tsx 在 showGameOver===true 时渲染（叠加在 GameScreen 之上）。
 * 内部从 store 读取 context.game.world 的 victoryState 渲染对应变体。
 */
export default function GameOverModal(): JSX.Element {
  const context = useGameStore((s) => s.context)
  const dismissGameOver = useGameStore((s) => s.dismissGameOver)

  // Hooks 必须在任何 early return 之前调用（react-hooks/rules-of-hooks）。
  // context 可能为 null（store 切换瞬间），useMemo 用空 world 兜底避免条件 hook。
  const world = context?.game.world ?? null
  const victoryState = world?.victoryState ?? 'ongoing'

  // 派生：玩家/敌方阵营视图 + 战损统计（基于真实 world 数据）。
  // world 为 null 时返回空 stats（不会渲染，下方 early return 拦截）。
  const stats = useMemo(
    () => (world ? deriveStats(world) : { playerFactionId: '', byFaction: [] }),
    [world],
  )
  // mock 导演部总结叙事（基于真实 world 数据，不伪造）。
  // world/victoryState 为兜底值时 narrative 也不渲染，但 hook 必须无条件调用。
  const campaignName = useMemo(
    () => (world ? getBuiltinCampaign(world.scenarioId)?.name ?? world.scenarioId : ''),
    [world],
  )
  const winnerFaction = useMemo(
    () =>
      world && world.winnerFactionId != null
        ? world.factions.find((f) => f.id === world.winnerFactionId) ?? null
        : null,
    [world],
  )
  const narrative = useMemo(
    () =>
      world && victoryState !== 'ongoing'
        ? buildMockNarrative(world, victoryState, winnerFaction, stats, campaignName)
        : '',
    [world, victoryState, winnerFaction, stats, campaignName],
  )

  // ESC 键关闭（与弹窗一致的无障碍快捷；等同「查看沙盘」）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissGameOver()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissGameOver])

  // early return（hook 之后）：context 丢失或未终局时不渲染。
  if (world === null) return <></>
  // 防御：若 victoryState 仍 ongoing（不应发生），不渲染。
  if (victoryState === 'ongoing') return <></>

  // 总回合数（0 起，UI 显示 +1；终局回合 = turnIndex+1）。
  const totalTurns = world.turnIndex + 1

  /** 返回标题屏：与 handleExit 一致（清 context=null + 对话记忆） */
  const handleReturnTitle = (): void => {
    logger.info('ui/gameover/return_title', '玩家从终局弹窗返回标题屏', {
      scope: 'save',
      saveId: world.saveId,
      victoryState,
    })
    useGameStore.setState({
      context: null,
      saveId: null,
      selectedUnitId: null,
      creatorPageActive: false,
      showGameOver: false,
    })
    useGameStore.getState().clearDialogues()
  }

  /** 查看沙盘：关闭弹窗，仍留游戏界面（dismissGameOver） */
  const handleViewSandbox = (): void => {
    logger.info('ui/gameover/view_sandbox', '玩家从终局弹窗查看沙盘', {
      scope: 'save',
      saveId: world.saveId,
      victoryState,
    })
    dismissGameOver()
  }

  return (
    <div
      className={`game-over-overlay game-over-overlay--${victoryState}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-over-title"
    >
      <div className="game-over-overlay__bg" aria-hidden="true" />
      <div className="game-over-overlay__card">
        {/* 标题（胜利金 / 失败红 / 平局灰） */}
        <header className="game-over-overlay__header">
          <span className="game-over-overlay__tag">
            {victoryState === 'won'
              ? '▌ VICTORY ▌'
              : victoryState === 'lost'
                ? '▌ DEFEAT ▌'
                : '▌ STALEMATE ▌'}
          </span>
          <h2 id="game-over-title" className="game-over-overlay__title">
            {victoryState === 'won'
              ? '战役胜利'
              : victoryState === 'lost'
                ? '战役失败'
                : '战役结束'}
          </h2>
          <p className="game-over-overlay__scenario">
            {campaignName} · 第 {totalTurns} 天
            {world.victoryMaxTurns != null && victoryState !== 'won' && victoryState !== 'lost'
              ? ` / 上限 ${world.victoryMaxTurns}`
              : ''}
          </p>
        </header>

        <div className="game-over-overlay__body">
          {/* 胜利条件达成摘要 */}
          <section className="game-over-overlay__section">
            <h3 className="game-over-overlay__section-label">[ 终局判定 ]</h3>
            <p className="game-over-overlay__reason">
              {world.victoryReason ?? '（无判定记录）'}
            </p>
            {winnerFaction && (
              <p className="game-over-overlay__winner">
                获胜方：<strong>{winnerFaction.name}</strong>
              </p>
            )}
          </section>

          {/* 最终战损统计 */}
          <section className="game-over-overlay__section">
            <h3 className="game-over-overlay__section-label">[ 最终战损 ]</h3>
            <table className="game-over-overlay__table">
              <thead>
                <tr>
                  <th>阵营</th>
                  <th>剩余兵力</th>
                  <th>累计损失</th>
                </tr>
              </thead>
              <tbody>
                {stats.byFaction.map((row) => (
                  <tr
                    key={row.factionId}
                    className={
                      row.factionId === stats.playerFactionId
                        ? 'game-over-overlay__row--player'
                        : ''
                    }
                  >
                    <td>
                      {row.name}
                      {row.factionId === stats.playerFactionId && ' (我方)'}
                    </td>
                    <td>{formatPersonnel(row.remainingPersonnel)}</td>
                    <td>{formatLoss(row.accumulatedLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 导演部总结叙事（mock 模板） */}
          <section className="game-over-overlay__section game-over-overlay__section--narrative">
            <h3 className="game-over-overlay__section-label">[ 导演部总结 ]</h3>
            <pre className="game-over-overlay__narrative">{narrative}</pre>
          </section>
        </div>

        <footer className="game-over-overlay__footer">
          <button
            type="button"
            className="game-over-overlay__btn game-over-overlay__btn--secondary"
            onClick={handleViewSandbox}
          >
            查看沙盘
          </button>
          <button
            type="button"
            className="game-over-overlay__btn game-over-overlay__btn--primary"
            onClick={handleReturnTitle}
          >
            返回标题屏
          </button>
        </footer>
      </div>
    </div>
  )
}

// =============================================================================
// 派生统计（基于真实 world 数据，不伪造）
// =============================================================================

/** 单阵营战损行。 */
interface FactionStatRow {
  factionId: string
  name: string
  /** 剩余 personnel（world.units 实时统计） */
  remainingPersonnel: number
  /** 累计 strength 损失（world.accumulatedCasualties） */
  accumulatedLoss: number
}

/** 派生统计结果。 */
interface DerivedStats {
  /** 玩家阵营 id */
  playerFactionId: string
  /** 各阵营战损行（按 factions 顺序） */
  byFaction: FactionStatRow[]
}

/**
 * 从 world 派生战损统计（基于真实数据）。
 *
 * - 剩余兵力：sum(units.personnel where factionId)。
 * - 累计损失：world.accumulatedCasualties[factionId]（旧存档缺失视为 0）。
 *
 * @param world 当前世界状态
 */
function deriveStats(world: WorldState): DerivedStats {
  const playerFactionId = getPlayerFactionId(world.factions, world.playerFactionId)
  const accumulated = world.accumulatedCasualties ?? {}
  const byFaction: FactionStatRow[] = world.factions.map((f: Faction) => {
    const remaining = world.units
      .filter((u) => u.factionId === f.id)
      .reduce((s, u) => s + u.personnel, 0)
    return {
      factionId: f.id,
      name: f.name,
      remainingPersonnel: remaining,
      accumulatedLoss: accumulated[f.id] ?? 0,
    }
  })
  return { playerFactionId, byFaction }
}

// =============================================================================
// mock 导演部总结叙事（基于真实 world 数据，不伪造）
// =============================================================================

/**
 * 生成 mock 导演部总结叙事（基于真实 world 数据）。
 *
 * - won：庆祝胜利 + 引用胜利条件 + 我方剩余兵力。
 * - lost：检讨失败 + 敌方优势 + 我方累计损失。
 * - draw：势均力敌 + 回合上限 + 双方损失对比。
 *
 * LLM 失败/未配置时兜底；不阻塞弹窗显示。
 *
 * @param world 当前世界状态
 * @param victoryState 胜负终局状态
 * @param winnerFaction 获胜阵营（draw 时为 null）
 * @param stats 派生战损统计
 * @param campaignName 战役名
 */
function buildMockNarrative(
  world: WorldState,
  victoryState: 'won' | 'lost' | 'draw',
  winnerFaction: Faction | null,
  stats: DerivedStats,
  campaignName: string,
): string {
  const playerRow = stats.byFaction.find((r) => r.factionId === stats.playerFactionId)
  const enemyRows = stats.byFaction.filter((r) => r.factionId !== stats.playerFactionId)
  const totalTurns = world.turnIndex + 1
  const playerRemaining = playerRow ? formatPersonnel(playerRow.remainingPersonnel) : '未知'
  const playerLoss = playerRow ? playerRow.accumulatedLoss : 0
  const enemyTotalLoss = enemyRows.reduce((s, r) => s + r.accumulatedLoss, 0)

  if (victoryState === 'won') {
    return (
      `${campaignName}战役于第 ${totalTurns} 天结束，我军取得胜利。\n` +
      `判定依据：${world.victoryReason ?? '达成既定战略目标'}。\n` +
      `我方剩余兵力约 ${playerRemaining}，敌方累计损失 ${enemyTotalLoss}。\n` +
      `参谋部评价：指挥得当，部队执行坚决，达成了开战时设定的战略目标。` +
      `此役将载入战史，作为经典战例供后世研究。`
    )
  }
  if (victoryState === 'lost') {
    return (
      `${campaignName}战役于第 ${totalTurns} 天结束，我军未能达成目标。\n` +
      `判定依据：${world.victoryReason ?? '敌方达成胜利条件'}。\n` +
      (winnerFaction ? `获胜方为${winnerFaction.name}。` : '') +
      `我方累计损失 ${playerLoss}，敌方仍保有相当战力。\n` +
      `参谋部检讨：需复盘指挥决策与兵力调度，吸取教训。` +
      `败北虽痛，但将士浴血奋战的勇气值得铭记。`
    )
  }
  // draw
  return (
    `${campaignName}战役于第 ${totalTurns} 天到达回合上限，双方势均力敌。\n` +
    `判定依据：${world.victoryReason ?? '回合上限到达，未分胜负'}。\n` +
    `我方累计损失 ${playerLoss}，敌方累计损失 ${enemyTotalLoss}，均无力发动决定性攻势。\n` +
    `参谋部评价：战役陷入僵持，双方都付出了惨重代价。` +
    `和谈或许是结束这场消耗的唯一出路。`
  )
}

/** 把 personnel 数格式化为「X 万」「X 千」「X」中文形式。 */
function formatPersonnel(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  if (n >= 1000) return `${(n / 1000).toFixed(1)} 千`
  return `${n}`
}

/** 格式化累计 strength 损失（整数）。 */
function formatLoss(n: number): string {
  return `${Math.round(n)}`
}

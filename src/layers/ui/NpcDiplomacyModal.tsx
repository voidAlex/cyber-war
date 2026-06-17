/**
 * NPC 主动外交弹窗（NpcDiplomacyModal.tsx）— T3-A。
 *
 * 职责：
 * - advanceTurn 结算后若 world.pendingNpcRequests 非空，App.tsx 渲染本组件
 *   （全屏叠加，赛博朋克 modal）。
 * - 显示 NPC 主动发起的外交请求（谁 → 什么类型 → 内容文本）：
 *   · ceasefire（求和）：NPC 劣势求和。
 *   · reinforcement（求援）：NPC 被攻击向玩家求援。
 *   · threat（威胁）：NPC 兵力优势威胁玩家投降。
 * - 玩家三选项：
 *   · 接受（accept）：ceasefire/reinforcement → trust+10；threat → trust 不变（让步）。
 *   · 拒绝（reject）：trust-5（关系紧张）。
 *   · 谈判（negotiate）：进入外交官对话 tab（切换 activeRoleId='diplomat'，不改 trust）。
 *
 * 数据来源（不伪造）：
 * - 请求文本：world.pendingNpcRequests[0]（domain/diplomacy-npc 模板生成）。
 * - 发起方阵营名：world.factions.find(f.id === fromFactionId)?.name。
 * - 请求类别中文标签：describeRequestKind（domain/diplomacy-request）。
 *
 * 响应后 store.respondNpcDiplomacy 修改 trust + 清空 pendingNpcRequests，
 * 弹窗自动消失（pendingNpcRequests 变空 → App 不再渲染）。
 *
 * @module layers/ui/NpcDiplomacyModal
 */

import { type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { describeRequestKind } from '@/layers/domain/diplomacy-request'
import type { DiplomaticRequest } from '@/types'

/**
 * NpcDiplomacyModal 组件。
 *
 * 由 App.tsx 在 world.pendingNpcRequests 非空时渲染。
 * 内部从 store 读 context.game.world.pendingNpcRequests[0] + factions。
 */
export default function NpcDiplomacyModal(): JSX.Element | null {
  const context = useGameStore((s) => s.context)
  const respondNpcDiplomacy = useGameStore((s) => s.respondNpcDiplomacy)
  const setActiveRole = useGameStore((s) => s.setActiveRole)

  const world = context?.game.world ?? null
  const requests = world?.pendingNpcRequests ?? []
  if (requests.length === 0) return null
  const request = requests[0]

  const fromFaction = world?.factions.find((f) => f.id === request.fromFactionId)
  const fromName = fromFaction?.name ?? request.fromFactionId
  const kindLabel = describeRequestKind(request.kind)

  // 不同请求类别的视觉强调色（赛博青蓝族谱 + 警示色）
  const accentClass =
    request.kind === 'threat'
      ? 'npc-diplomacy-modal--threat'
      : request.kind === 'ceasefire'
        ? 'npc-diplomacy-modal--ceasefire'
        : request.kind === 'reinforcement'
          ? 'npc-diplomacy-modal--reinforcement'
          : 'npc-diplomacy-modal--other'

  /** 玩家点击"接受" */
  const handleAccept = (): void => {
    respondNpcDiplomacy(request, 'accept')
  }
  /** 玩家点击"拒绝" */
  const handleReject = (): void => {
    respondNpcDiplomacy(request, 'reject')
  }
  /** 玩家点击"谈判"：切换到外交官对话 tab + 清空请求 */
  const handleNegotiate = (): void => {
    respondNpcDiplomacy(request, 'negotiate')
    setActiveRole('diplomat')
  }

  return (
    <div className={`npc-diplomacy-modal ${accentClass}`} role="dialog" aria-modal="true">
      <div className="npc-diplomacy-modal__card">
        <header className="npc-diplomacy-modal__header">
          <span className="npc-diplomacy-modal__badge">{kindLabel}</span>
          <h2 className="npc-diplomacy-modal__title">
            {fromName} 的外交信使
          </h2>
        </header>

        <div className="npc-diplomacy-modal__body">
          <p className="npc-diplomacy-modal__text">{request.text}</p>
          <p className="npc-diplomacy-modal__hint">
            {hintForKind(request)}
          </p>
        </div>

        <footer className="npc-diplomacy-modal__actions">
          <button
            type="button"
            className="npc-diplomacy-modal__btn npc-diplomacy-modal__btn--accept"
            onClick={handleAccept}
          >
            接受
          </button>
          <button
            type="button"
            className="npc-diplomacy-modal__btn npc-diplomacy-modal__btn--negotiate"
            onClick={handleNegotiate}
          >
            谈判
          </button>
          <button
            type="button"
            className="npc-diplomacy-modal__btn npc-diplomacy-modal__btn--reject"
            onClick={handleReject}
          >
            拒绝
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * 按请求类别给出玩家决策提示（说明各选项的信任度后果）。
 */
function hintForKind(request: DiplomaticRequest): string {
  switch (request.kind) {
    case 'ceasefire':
      return '接受 → 达成停火（信任 +10）；拒绝 → 关系紧张（信任 -5）；谈判 → 进入外交对话。'
    case 'reinforcement':
      return '接受 → 承诺增援（信任 +10）；拒绝 → 关系紧张（信任 -5）；谈判 → 进入外交对话。'
    case 'threat':
      return '接受 → 屈辱让步（避免冲突）；拒绝 → 关系紧张（信任 -5）；谈判 → 进入外交对话。'
    default:
      return '接受 → 履约（信任 +10）；拒绝 → 关系紧张（信任 -5）；谈判 → 进入外交对话。'
  }
}

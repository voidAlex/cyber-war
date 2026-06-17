/**
 * 对话气泡流（DialogueStream.tsx）— 中栏主体（UI 重构第 1 批 + 第 2+3 批角色 tab）。
 *
 * 职责：占据中栏，承载玩家与各角色的对话气泡流 + 顶部角色 tab 栏 + 底部输入框。
 *
 * 第 2+3 批「角色 tab 对话」：
 * - 顶部 tab 栏读 useCommandDialogue.playerRoles（campaign rules.aiRoles 过滤玩家侧）。
 * - 切换 tab → setActiveRole → 气泡按 dialoguesByRole[activeRoleId] 过滤渲染。
 * - 色标按 role type：chief=青、diplomat=蓝、commander=橙、director=紫、player=白。
 * - 命令解析（parseCommand）仍走 chief，不受 tab 影响（classifyInput 命中 → handleParse）。
 *
 * 对话气泡历史（dialogues）由 useCommandDialogue hook 持有，按 activeRoleId 过滤。
 * - 主输入框：classifyInput 路由「命令」/「对话」（命令走 chief 解析，对话走当前 tab 角色）。
 *
 * 不 import @tauri-apps/api（UI 层）。gateway 唯一。
 *
 * @module layers/ui/terminal/DialogueStream
 */

import { useEffect, useRef, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import { useCommandDialogue, type PlayerRoleTab } from './useCommandDialogue'

/**
 * 对话气泡流组件（中栏主体）。
 *
 * 自身仅渲染 tab 栏 + 气泡流 + 输入框；命令/外交交互在 CommandTerminal 右栏。
 * 通过 useCommandDialogue 与右栏共享对话历史（各角色回复一致）。
 */
export default function DialogueStream(): JSX.Element {
  const {
    context,
    busy,
    phase,
    draftCommand,
    setDraftCommand,
    parsing,
    handleSubmit,
    dialogues,
    activeRoleId,
    setActiveRole,
    playerRoles,
    userError,
    clearError,
    canSubmit,
  } = useCommandDialogue()

  // 第 2 批：订阅 store liveChat（角色对话流式 partial），渲染「正在输入」打字机气泡。
  const liveChat = useGameStore((s) => s.liveChat)

  // 对话流容器 ref：新消息/liveChat 增量时自动滚到底（玩家始终看到最新回复）。
  const streamRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = streamRef.current
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
  }, [dialogues, liveChat])

  // 未加载存档：占位
  if (context === null) {
    return (
      <section className="panel dialogue-stream" aria-label="对话流">
        <p className="dialogue-stream__empty">请先在左栏创建或载入存档开始对话。</p>
      </section>
    )
  }

  const inputEnabled = canSubmit
  const phaseHint = PHASE_NAMES[phase] ?? phase
  const activeTab = playerRoles.find((t) => t.roleId === activeRoleId) ?? playerRoles[0]
  const activeType = activeTab?.type ?? 'chief'

  return (
    <section className="panel dialogue-stream" aria-label="对话流">
      {/* 第 2+3 批：角色 tab 栏（玩家侧角色：参谋长/外交官/各指挥官） */}
      {playerRoles.length > 0 && (
        <div className="role-tabs" role="tablist" aria-label="角色对话切换">
          {playerRoles.map((tab) => (
            <button
              key={tab.roleId}
              type="button"
              role="tab"
              aria-selected={tab.roleId === activeRoleId}
              className={
                'role-tab role-tab--' + tab.type +
                (tab.roleId === activeRoleId ? ' role-tab--active' : '')
              }
              onClick={() => setActiveRole(tab.roleId)}
            >
              <span className="role-tab__icon" aria-hidden>{ROLE_ICON[tab.type] ?? '◆'}</span>
              <span className="role-tab__label">{tab.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* 对话气泡流（可滚动，撑满中栏剩余空间） */}
      <div className="dialogue-stream__stream" ref={streamRef}>
        {dialogues.length === 0 && (
          <p className="dialogue-stream__hint">
            {activeTab
              ? `与${activeTab.label}对话，或输入命令（如「第一装甲师移动到 C3」）。`
              : '输入命令或与参谋长对话。例如：「第一装甲师移动到 C3」或「你好」。'}
          </p>
        )}

        {dialogues.map((d, i) => (
          <DialogueBubble
            key={i}
            input={d.input}
            replyText={d.reply.text}
            replySource={d.reply.source}
            roleType={activeType}
            roleLabel={activeTab?.label ?? '参谋长'}
          />
        ))}

        {/* 第 2 批：角色对话流式进行中 → 渲染「正在输入」打字机气泡（按角色色标）。 */}
        {liveChat !== null && (
          <TypingBubble
            text={liveChat.text}
            roleType={activeType}
            roleLabel={activeTab?.label ?? '参谋长'}
          />
        )}
      </div>

      {/* 输入框：固定底部，单框 + 发送按钮 */}
      <div className="dialogue-stream__input-row">
        <input
          type="text"
          className="dialogue-stream__input"
          placeholder={inputEnabled ? `命令或与${activeTab?.label ?? '参谋长'}对话…（如 第一装甲师移动到 C3 / 你好）` : `阶段「${phaseHint}」——可对话，命令待规划阶段`}
          value={draftCommand}
          onChange={(e) => setDraftCommand(e.target.value)}
          disabled={busy || parsing}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !parsing && !busy && draftCommand.trim().length > 0) {
              void handleSubmit()
            }
          }}
        />
        <button
          type="button"
          className="dialogue-stream__send"
          onClick={() => void handleSubmit()}
          disabled={busy || parsing || draftCommand.trim().length === 0}
        >
          {parsing ? '处理中…' : '发送'}
        </button>
      </div>

      {!inputEnabled && !busy && (
        <p className="dialogue-stream__phase-hint">
          当前阶段「{phaseHint}」——无法下达命令，但仍可对话（问候/询问态势）。
        </p>
      )}

      {userError !== null && (
        <div className="dialogue-stream__error" role="alert">
          <span>{userError}</span>
          <button type="button" onClick={clearError}>知道了</button>
        </div>
      )}
    </section>
  )
}

/** phase 中文提示 */
const PHASE_NAMES: Record<string, string> = {
  idle: '空闲',
  planning: '规划',
  handshake: '握手确认',
  locked: '已锁定',
  resolution: '结算中',
  briefing: '战报',
  persist: '持久化',
  decision: '战术决策',
}

/** 各角色 tab 图标（单字标识，色标由 CSS --role-{type} 变量驱动）。 */
const ROLE_ICON: Record<PlayerRoleTab['type'], string> = {
  chief: '参',
  diplomat: '外',
  commander: '指',
  director: '导',
  player: '我',
}

/**
 * 对话气泡（玩家问话 + 角色回复）。
 *
 * 玩家问话右对齐白底（指挥官橙 speaker），角色回复左对齐按 role type 色标。
 */
function DialogueBubble({
  input,
  replyText,
  replySource,
  roleType,
  roleLabel,
}: {
  input: string
  replyText: string
  replySource: 'mock' | 'llm'
  roleType: PlayerRoleTab['type']
  roleLabel: string
}): JSX.Element {
  return (
    <div className="dialogue-stream__turn">
      <div className="dialogue-stream__bubble dialogue-stream__bubble--player">
        <span className="dialogue-stream__speaker dialogue-stream__speaker--player">指挥官</span>
        <p className="dialogue-stream__text">{input}</p>
      </div>
      <div className={'dialogue-stream__bubble dialogue-stream__bubble--role dialogue-stream__bubble--role-' + roleType}>
        <span className={'dialogue-stream__speaker dialogue-stream__speaker--role dialogue-stream__speaker--role-' + roleType}>{roleLabel}</span>
        <p className="dialogue-stream__text">{replyText}</p>
        <span className="dialogue-stream__source">
          {replySource === 'llm' ? 'LLM' : '离线模板'}
        </span>
      </div>
    </div>
  )
}

/**
 * 「正在输入」打字机气泡（第 2 批流式 + 第 2+3 批角色色标）。
 *
 * 角色对话流式进行中显示：按 role type 色标描边（闪烁动画）+ 已到达的 partial 文本 + 末尾光标。
 * 流式完成后 store clearLiveChat，此气泡消失，完整回复已入 dialogues 转正常气泡。
 */
function TypingBubble({
  text,
  roleType,
  roleLabel,
}: {
  text: string
  roleType: PlayerRoleTab['type']
  roleLabel: string
}): JSX.Element {
  return (
    <div className="dialogue-stream__turn dialogue-stream__turn--typing">
      <div className={'dialogue-stream__bubble dialogue-stream__bubble--role dialogue-stream__bubble--role-' + roleType + ' dialogue-stream__bubble--typing'}>
        <span className={'dialogue-stream__speaker dialogue-stream__speaker--role dialogue-stream__speaker--role-' + roleType}>{roleLabel}</span>
        <p className="dialogue-stream__text">
          {text}
          {/* 末尾闪烁光标，模拟打字机「正在输出」 */}
          <span className="dialogue-stream__cursor" aria-hidden="true" />
        </p>
      </div>
    </div>
  )
}

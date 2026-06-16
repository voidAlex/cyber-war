/**
 * 对话气泡流（DialogueStream.tsx）— UI 重构第 1 批「全对话为主」中栏主体。
 *
 * 职责：占据中栏，承载玩家与各角色的对话气泡流 + 底部固定输入框。
 * 对话气泡按角色色标：
 * - 参谋长（chief）：青
 * - 外交（盟友统帅）：蓝
 * - 指挥官（玩家）：橙
 * - 导演部（战报/终裁）：紫
 * - 玩家输入：白底
 *
 * 逻辑复用：与 CommandTerminal 共享 useCommandDialogue hook（对话/命令/外交不重写）。
 * - 主输入框：classifyInput 路由「命令」/「对话」（与原 CommandTerminal 一致）。
 * - 对话历史（dialogues）由 hook 持有，中右两栏渲染同一份（参谋长回复一致）。
 * - 命令候选卡 / 外交卡 / 待锁队列：在 CommandTerminal 右栏呈现，DialogueStream 不重复。
 *
 * 不 import @tauri-apps/api（UI 层）。gateway 唯一。
 *
 * @module layers/ui/terminal/DialogueStream
 */

import { useEffect, useRef, type JSX } from 'react'
import { useCommandDialogue } from './useCommandDialogue'
import type { ChiefChatResult } from '@/layers/agents/roles/chief'

/**
 * 对话气泡流组件（中栏主体）。
 *
 * 自身仅渲染气泡流 + 输入框；命令/外交交互在 CommandTerminal 右栏。
 * 通过 useCommandDialogue 与右栏共享对话历史（参谋长回复一致）。
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
    userError,
    clearError,
    canSubmit,
  } = useCommandDialogue()

  // 对话流容器 ref：新消息时自动滚到底（玩家始终看到最新回复）。
  const streamRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = streamRef.current
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
  }, [dialogues])

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

  return (
    <section className="panel dialogue-stream" aria-label="对话流">
      {/* 对话气泡流（可滚动，撑满中栏剩余空间） */}
      <div className="dialogue-stream__stream" ref={streamRef}>
        {dialogues.length === 0 && (
          <p className="dialogue-stream__hint">
            输入命令或与参谋长对话。例如：「第一装甲师移动到 C3」或「你好」。
          </p>
        )}

        {dialogues.map((d, i) => (
          <DialogueBubble key={i} input={d.input} reply={d.reply} />
        ))}
      </div>

      {/* 输入框：固定底部，单框 + 发送按钮 */}
      <div className="dialogue-stream__input-row">
        <input
          type="text"
          className="dialogue-stream__input"
          placeholder={inputEnabled ? '命令或对话…（如 第一装甲师移动到 C3 / 你好）' : `阶段「${phaseHint}」——可对话，命令待规划阶段`}
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
          当前阶段「{phaseHint}」——无法下达命令，但仍可与参谋长对话（问候/询问态势）。
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

/**
 * 对话气泡（玩家问话 + 参谋长回复）。
 *
 * 玩家问话右对齐白底（指挥官橙 speaker），参谋长回复左对齐青光。
 */
function DialogueBubble({
  input,
  reply,
}: {
  input: string
  reply: ChiefChatResult
}): JSX.Element {
  return (
    <div className="dialogue-stream__turn">
      <div className="dialogue-stream__bubble dialogue-stream__bubble--player">
        <span className="dialogue-stream__speaker dialogue-stream__speaker--player">指挥官</span>
        <p className="dialogue-stream__text">{input}</p>
      </div>
      <div className="dialogue-stream__bubble dialogue-stream__bubble--chief">
        <span className="dialogue-stream__speaker dialogue-stream__speaker--chief">参谋长</span>
        <p className="dialogue-stream__text">{reply.text}</p>
        <span className="dialogue-stream__source">
          {reply.source === 'llm' ? 'LLM' : '离线模板'}
        </span>
      </div>
    </div>
  )
}

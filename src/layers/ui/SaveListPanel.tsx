/**
 * 存档列表面板（SaveListPanel.tsx）— M1 最小可演示。
 *
 * 职责：
 * - 启动时刷新存档列表（调 listSaves）。
 * - 创建新存档（输入名 → createSave）。
 * - 载入存档（恢复 world-state）。
 * - 删除存档。
 *
 * 通过 zustand store 订阅；按钮按 busy/userError 守卫。
 * 不直接调 @tauri-apps/api（经 store → persistence-service → gateway）。
 *
 * @module layers/ui/SaveListPanel
 */

import { useEffect, useState, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'

/**
 * 存档列表面板组件。
 */
export default function SaveListPanel(): JSX.Element {
  const saves = useGameStore((s) => s.saves)
  const saveId = useGameStore((s) => s.saveId)
  const busy = useGameStore((s) => s.busy)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const createSave = useGameStore((s) => s.createSave)
  const loadSave = useGameStore((s) => s.loadSave)
  const deleteSave = useGameStore((s) => s.deleteSave)

  const [draftName, setDraftName] = useState('')

  // 启动即刷新存档列表
  useEffect(() => {
    void refreshSaves()
  }, [refreshSaves])

  const handleCreate = (): void => {
    const name = draftName.trim()
    if (name.length === 0) return
    void createSave(name, name)
    setDraftName('')
  }

  return (
    <section className="panel save-list-panel">
      <h2 className="panel__title">存档</h2>

      <div className="save-list-panel__create">
        <input
          type="text"
          placeholder="新存档名"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          disabled={busy}
        />
        <button type="button" onClick={handleCreate} disabled={busy || draftName.trim().length === 0}>
          创建存档
        </button>
        <button type="button" onClick={() => void refreshSaves()} disabled={busy}>
          刷新
        </button>
      </div>

      <ul className="save-list-panel__list">
        {saves.length === 0 && <li className="save-list-panel__empty">（暂无存档）</li>}
        {saves.map((id) => (
          <li key={id} className="save-list-panel__item">
            <span className="save-list-panel__name">{id}</span>
            {saveId === id && <span className="save-list-panel__tag">[当前]</span>}
            <button type="button" onClick={() => void loadSave(id)} disabled={busy}>
              载入
            </button>
            <button
              type="button"
              onClick={() => void deleteSave(id)}
              disabled={busy}
              className="save-list-panel__delete"
            >
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 战役面板（CampaignPanel.tsx）— M4-A ZIP 战役包导入导出 + 开局 UI。
 *
 * 职责（验收#5 ZIP 闭环）：
 * - 开局凡尔登默认示例包（选阵营 → startDefaultCampaign → setFromWorld 载入）。
 * - 导入战役包 ZIP（文件选择 → loadCampaignZip 内存校验 → startCampaignFromPayload 开局）。
 * - 导入存档 ZIP（路径输入 → importSaveZip → refreshSaves）。
 * - 导出当前存档 ZIP（路径输入 → exportSaveAsZip）。
 *
 * 设计说明：
 * - 战役包 ZIP 导入走**内存校验闭环**（<input type=file> 读字节 → loadCampaignZip
 *   ajv 校验 → startCampaignFromPayload），不经 Rust 解包，校验失败即拒绝，安全。
 * - 存档 ZIP 导入导出需绝对路径（Rust fs_import_save / fs_export_save），
 *   当前通过文本输入框提供路径（避免引入 Tauri dialog 插件依赖）。
 *
 * 经 zustand store 订阅 busy/userError；不直接调 @tauri-apps/api。
 *
 * @module layers/ui/CampaignPanel
 */

import { useState, type JSX, type ChangeEvent } from 'react'
import { useGameStore } from '@/store/game-store'
import {
  loadCampaignZip,
  exportSaveAsZip,
  importSaveZip,
  CampaignSchemaError,
  CampaignZipError,
} from '@/layers/persistence'
import {
  startCampaignFromPayload,
  startDefaultCampaign,
} from '@/layers/persistence'
import type { CampaignPayload } from '@/types'
import CampaignGeneratorPanel from './CampaignGeneratorPanel'

/** 凡尔登玩家可选阵营 */
const VERDUN_FACTIONS = [
  { id: 'france', label: '法国（守）' },
  { id: 'germany', label: '德国（攻）' },
] as const

/**
 * 战役面板组件。
 */
export default function CampaignPanel(): JSX.Element {
  const busy = useGameStore((s) => s.busy)
  const saveId = useGameStore((s) => s.saveId)
  const refreshSaves = useGameStore((s) => s.refreshSaves)
  const setFromWorld = useGameStore((s) => s.setFromWorld)
  const clearError = useGameStore((s) => s.clearError)

  // 凡尔登开局所选阵营
  const [verdunFaction, setVerdunFaction] = useState<string>('france')
  // 导入战役包 ZIP 后暂存的 payload（预览待确认）
  const [pendingPayload, setPendingPayload] = useState<CampaignPayload | null>(null)
  const [pendingFaction, setPendingFaction] = useState<string>('')
  // 存档 ZIP 导入导出路径输入
  const [importSavePath, setImportSavePath] = useState('')
  const [exportSavePath, setExportSavePath] = useState('')
  const [message, setMessage] = useState<string>('')

  // —— 凡尔登默认示例包开局 ——
  const handleStartVerdun = async (): Promise<void> => {
    clearError()
    setMessage('')
    try {
      // saveId 用 scenarioId + 时间戳避免冲突
      const newSaveId = `verdun-1916-${Date.now()}`
      const world = await startDefaultCampaign(newSaveId, verdunFaction)
      setFromWorld(world, newSaveId)
      await refreshSaves()
      setMessage(`已开局凡尔登战役（${verdunFaction === 'france' ? '法国' : '德国'}），存档 ${newSaveId}`)
    } catch (err) {
      setMessage(`开局失败：${formatErr(err)}`)
    }
  }

  // —— 导入战役包 ZIP（内存校验闭环）——
  const handleImportCampaignZip = async (
    e: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    clearError()
    setMessage('')
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const zipBytes = new Uint8Array(await file.arrayBuffer())
      // 内存解包 + ajv 校验（失败 throw，不加载损坏包）
      const payload = loadCampaignZip(zipBytes)
      setPendingPayload(payload)
      // 默认预选 manifest.playerFactionIds 第一个
      setPendingFaction(payload.manifest.playerFactionIds[0] ?? '')
      setMessage(
        `战役包「${payload.manifest.displayName}」校验通过，请选择阵营后确认开局`,
      )
    } catch (err) {
      setPendingPayload(null)
      setMessage(`战役包校验失败：${formatErr(err)}`)
    } finally {
      // 清空 input 以便重复选择同一文件
      e.target.value = ''
    }
  }

  // —— 确认导入的开局 ——
  const handleConfirmCampaign = async (): Promise<void> => {
    if (!pendingPayload) return
    clearError()
    setMessage('')
    try {
      const newSaveId = `${pendingPayload.manifest.scenarioId}-${Date.now()}`
      const world = await startCampaignFromPayload(
        pendingPayload,
        newSaveId,
        pendingFaction,
      )
      setFromWorld(world, newSaveId)
      await refreshSaves()
      setPendingPayload(null)
      setMessage(`已开局战役「${pendingPayload.manifest.displayName}」，存档 ${newSaveId}`)
    } catch (err) {
      setMessage(`开局失败：${formatErr(err)}`)
    }
  }

  // —— 导入存档 ZIP（经 Rust fs_import_save，防 zip-slip）——
  const handleImportSave = async (): Promise<void> => {
    clearError()
    setMessage('')
    const path = importSavePath.trim()
    if (path.length === 0) {
      setMessage('请输入存档 ZIP 的绝对路径')
      return
    }
    const newSaveId = `imported-${Date.now()}`
    try {
      await importSaveZip(newSaveId, path)
      await refreshSaves()
      setMessage(`存档 ZIP 已导入为 ${newSaveId}`)
      setImportSavePath('')
    } catch (err) {
      setMessage(`存档导入失败：${formatErr(err)}`)
    }
  }

  // —— 导出当前存档 ZIP（经 Rust fs_export_save）——
  const handleExportSave = async (): Promise<void> => {
    clearError()
    setMessage('')
    if (!saveId) {
      setMessage('无当前存档可导出')
      return
    }
    const path = exportSavePath.trim()
    if (path.length === 0) {
      setMessage('请输入导出 ZIP 的绝对路径')
      return
    }
    try {
      await exportSaveAsZip(saveId, path)
      setMessage(`存档 ${saveId} 已导出到 ${path}`)
      setExportSavePath('')
    } catch (err) {
      setMessage(`存档导出失败：${formatErr(err)}`)
    }
  }

  return (
    <section className="panel campaign-panel">
      <h2 className="panel__title">战役包</h2>

      {/* 默认示例包开局 */}
      <div className="campaign-panel__section">
        <h3 className="campaign-panel__subtitle">凡尔登战役 1916（默认示例包）</h3>
        <div className="campaign-panel__row">
          <select
            value={verdunFaction}
            onChange={(e) => setVerdunFaction(e.target.value)}
            disabled={busy}
          >
            {VERDUN_FACTIONS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleStartVerdun()}
            disabled={busy}
          >
            开局凡尔登
          </button>
        </div>
        <p className="campaign-panel__hint">
          消耗战 · 默兹河两岸 · 杜奥蒙堡/沃堡/苏维尔堡。schema 已内置校验。
        </p>
      </div>

      {/* 导入战役包 ZIP */}
      <div className="campaign-panel__section">
        <h3 className="campaign-panel__subtitle">导入战役包 ZIP</h3>
        <input
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => void handleImportCampaignZip(e)}
          disabled={busy}
        />
        {pendingPayload && (
          <div className="campaign-panel__confirm">
            <span>
              「{pendingPayload.manifest.displayName}」待开局
            </span>
            <select
              value={pendingFaction}
              onChange={(e) => setPendingFaction(e.target.value)}
              disabled={busy}
            >
              {pendingPayload.manifest.playerFactionIds.map((fid) => (
                <option key={fid} value={fid}>
                  {fid}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleConfirmCampaign()}
              disabled={busy || pendingFaction.length === 0}
            >
              确认开局
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingPayload(null)
                setMessage('')
              }}
              disabled={busy}
            >
              取消
            </button>
          </div>
        )}
        <p className="campaign-panel__hint">
          ZIP 经内存 ajv 校验（七文件 schema），失败即拒绝，不加载损坏/恶意包。
        </p>
      </div>

      {/* 生成新战役（LLM）入口 */}
      <div className="campaign-panel__section">
        <CampaignGeneratorPanel />
      </div>

      {/* 导入存档 ZIP */}
      <div className="campaign-panel__section">
        <h3 className="campaign-panel__subtitle">导入存档 ZIP</h3>
        <div className="campaign-panel__row">
          <input
            type="text"
            placeholder="存档 ZIP 绝对路径"
            value={importSavePath}
            onChange={(e) => setImportSavePath(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void handleImportSave()}
            disabled={busy || importSavePath.trim().length === 0}
          >
            导入存档
          </button>
        </div>
        <p className="campaign-panel__hint">经 Rust fs_import_save 解包（防 zip-slip）。</p>
      </div>

      {/* 导出当前存档 ZIP */}
      <div className="campaign-panel__section">
        <h3 className="campaign-panel__subtitle">
          导出当前存档 ZIP{saveId ? `（${saveId}）` : '（无当前存档）'}
        </h3>
        <div className="campaign-panel__row">
          <input
            type="text"
            placeholder="导出 ZIP 绝对路径"
            value={exportSavePath}
            onChange={(e) => setExportSavePath(e.target.value)}
            disabled={busy || !saveId}
          />
          <button
            type="button"
            onClick={() => void handleExportSave()}
            disabled={busy || !saveId || exportSavePath.trim().length === 0}
          >
            导出存档
          </button>
        </div>
      </div>

      {message && <p className="campaign-panel__message">{message}</p>}
    </section>
  )
}

/** 格式化错误信息（含 schema/zip 错误的字段级细节） */
function formatErr(err: unknown): string {
  if (err instanceof CampaignSchemaError) {
    const detail = err.errors
      ? err.errors.map((e) => e.instancePath || JSON.stringify(e)).join('; ')
      : ''
    return `${err.message}${detail ? ` [${detail}]` : ''}`
  }
  if (err instanceof CampaignZipError) {
    const missing = err.missingFiles ? ` 缺失: ${err.missingFiles.join(', ')}` : ''
    return `${err.message}${missing}`
  }
  return err instanceof Error ? err.message : String(err)
}

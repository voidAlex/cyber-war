/**
 * LLM 配置面板（LLMConfigPanel.tsx）— M3 UI 层（去口令改造后）。
 *
 * 职责（对应重写计划「DeepSeek 推荐供应商」+ M3 范围#1 + 去口令 §前端）：
 * - 表单：provider 下拉（DeepSeek v4-flash 默认推荐 / v4-pro / openai / anthropic / custom）。
 * - endpoint/model 按 provider 自动填默认（可改）。
 * - apiKey（无 passphrase，经 OS 凭证库存取）。
 * - 保存：调 saveConfig（keyring 存 apiKey + 明文 config 落盘）→ 会话加载。
 *
 * 三互斥视图（去口令后无解锁面板）：
 * ①`configUnlocked && config`：显示 provider/model/endpoint + keyring 降级警告 + "重新配置"。
 * ②`hasConfig && !configUnlocked`（legacy/no-api-key）：提示重输 apiKey，预填 provider/endpoint/model。
 * ③首次（无 config）：ConfigForm 四项，无 passphrase。
 *
 * gateway 唯一 import @tauri-apps/api；本组件经 store/hooks，不直接调 gateway。
 *
 * @module layers/ui/config/LLMConfigPanel
 */

import { useState, type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import type { ProviderKindString } from '@/layers/gateway/bridge-types'
import type { RuntimeLLMConfig } from '@/layers/gateway/runtime-config'

/** provider 选项（DeepSeek 为推荐默认） */
type ProviderOption = ProviderKindString | 'deepseek-pro'

/** provider 下拉项 */
const PROVIDER_OPTIONS: Array<{ value: ProviderOption; label: string; recommended?: boolean }> = [
  { value: 'deepseek', label: 'DeepSeek v4-flash（推荐默认 · 便宜高并发）', recommended: true },
  { value: 'deepseek-pro', label: 'DeepSeek v4-pro（强推理 · 导演部终裁）' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'custom', label: '自定义（custom）' },
]

/** 各 provider 默认 endpoint（OpenAI/DeepSeek 兼容 chat/completions 路径） */
function defaultEndpoint(option: ProviderOption): string {
  switch (option) {
    case 'deepseek':
    case 'deepseek-pro':
      return 'https://api.deepseek.com/v1/chat/completions'
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions'
    case 'anthropic':
      return 'https://api.anthropic.com/v1/messages'
    case 'custom':
      return ''
  }
}

/** 各 provider 默认 model */
function defaultModel(option: ProviderOption): string {
  switch (option) {
    case 'deepseek':
      return 'deepseek-v4-flash'
    case 'deepseek-pro':
      return 'deepseek-v4-pro'
    case 'openai':
      return 'gpt-4o-mini'
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022'
    case 'custom':
      return ''
  }
}

/** ProviderOption → 落盘用的 ProviderKindString（deepseek-pro 归一为 deepseek） */
function toProviderKind(option: ProviderOption): ProviderKindString {
  return option === 'deepseek-pro' ? 'deepseek' : option
}

/**
 * 从 provider 字符串反推 ProviderOption（用于从旧 config 预填表单）。
 * 默认 deepseek，未匹配归一为对应 kind。
 */
function providerKindToOption(kind: ProviderKindString): ProviderOption {
  return kind
}

/**
 * LLM 配置面板组件。
 */
export default function LLMConfigPanel(): JSX.Element {
  const hasConfig = useGameStore((s) => s.hasConfig)
  const configUnlocked = useGameStore((s) => s.configUnlocked)
  const config = useGameStore((s) => s.config)
  // legacy/no-api-key 时从旧 config 文件读到的非密钥字段（供表单预填）
  const pendingConfig = useGameStore((s) => s.pendingConfig)
  const keyBackendWarning = useGameStore((s) => s.keyBackendWarning)
  const busy = useGameStore((s) => s.busy)
  const userError = useGameStore((s) => s.userError)
  const saveConfig = useGameStore((s) => s.saveConfig)
  const clearError = useGameStore((s) => s.clearError)

  // 表单状态（首次默认 DeepSeek v4-flash；legacy/no-api-key 时从 pendingConfig 预填）
  const initialOption = pendingConfig
    ? providerKindToOption(pendingConfig.provider as ProviderKindString)
    : 'deepseek'
  const [providerOption, setProviderOption] = useState<ProviderOption>(initialOption)
  const [endpoint, setEndpoint] = useState(
    pendingConfig?.endpoint ?? defaultEndpoint(initialOption),
  )
  const [model, setModel] = useState(pendingConfig?.model ?? defaultModel(initialOption))
  const [apiKey, setApiKey] = useState('')
  const [showConfigForm, setShowConfigForm] = useState(false)

  const handleProviderChange = (opt: ProviderOption): void => {
    setProviderOption(opt)
    setEndpoint(defaultEndpoint(opt))
    setModel(defaultModel(opt))
  }

  const handleSave = (): void => {
    const trimmedKey = apiKey.trim()
    if (trimmedKey.length === 0) return
    const cfg: RuntimeLLMConfig = {
      provider: toProviderKind(providerOption),
      endpoint: endpoint.trim() || defaultEndpoint(providerOption),
      model: model.trim() || defaultModel(providerOption),
      apiKey: trimmedKey,
    }
    void saveConfig(cfg).then(() => {
      setApiKey('')
      setShowConfigForm(false)
    })
  }

  // ① 已加载（会话内存持有明文 apiKey）：显示当前配置 + 降级警告 + 重新配置入口
  if (configUnlocked && config) {
    return (
      <section className="panel llm-config-panel">
        <h2 className="panel__title">LLM 配置</h2>
        <dl className="llm-config-panel__status">
          <div><dt>供应商</dt><dd>{config.provider}</dd></div>
          <div><dt>模型</dt><dd>{config.model}</dd></div>
          <div><dt>Endpoint</dt><dd className="llm-config-panel__endpoint">{config.endpoint}</dd></div>
          <div><dt>状态</dt><dd className="llm-config-panel__unlocked">已加载（apiKey 仅存内存）</dd></div>
        </dl>
        {keyBackendWarning !== null && (
          <p className="llm-config-panel__hint" role="alert">{keyBackendWarning}</p>
        )}
        <div className="llm-config-panel__actions">
          <button type="button" onClick={() => setShowConfigForm((v) => !v)} disabled={busy}>
            {showConfigForm ? '收起' : '重新配置'}
          </button>
        </div>
        {showConfigForm && <ConfigForm />}
      </section>
    )
  }

  // ② 有配置但未加载（legacy/no-api-key）：提示重输 apiKey，预填非密钥字段
  if (hasConfig) {
    return (
      <section className="panel llm-config-panel">
        <h2 className="panel__title">LLM 配置</h2>
        <p className="llm-config-panel__hint">
          {userError ?? '检测到已保存的配置，但 apiKey 不可用（可能是旧版加密配置或凭证库无记录）。请重新输入 API Key。'}
        </p>
        <ConfigForm />
        {userError !== null && <ErrorInline message={userError} onDismiss={clearError} />}
      </section>
    )
  }

  // ③ 无配置：首次配置表单
  return (
    <section className="panel llm-config-panel">
      <h2 className="panel__title">LLM 配置（首次使用）</h2>
      <p className="llm-config-panel__hint">
        apiKey 经操作系统凭证库加密保存（桌面端无需口令，重启自动加载）。
        推荐使用 DeepSeek v4-flash（便宜、高并发、支持缓存）。
      </p>
      <ConfigForm />
      {userError !== null && <ErrorInline message={userError} onDismiss={clearError} />}
    </section>
  )

  // —— 内联配置表单（首次 / 重新配置 / 重输 apiKey 复用） ——
  function ConfigForm(): JSX.Element {
    return (
      <div className="llm-config-panel__form">
        <div className="llm-config-panel__field">
          <label htmlFor="provider">供应商</label>
          <select
            id="provider"
            value={providerOption}
            onChange={(e) => handleProviderChange(e.target.value as ProviderOption)}
            disabled={busy}
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="llm-config-panel__field">
          <label htmlFor="endpoint">Endpoint</label>
          <input
            id="endpoint"
            type="text"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            disabled={busy}
            placeholder={defaultEndpoint(providerOption)}
          />
        </div>
        <div className="llm-config-panel__field">
          <label htmlFor="model">模型</label>
          <input
            id="model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            placeholder={defaultModel(providerOption)}
          />
        </div>
        <div className="llm-config-panel__field">
          <label htmlFor="apikey">API Key</label>
          <input
            id="apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={busy}
            placeholder="sk-..."
          />
        </div>
        <div className="llm-config-panel__actions">
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || apiKey.trim().length === 0}
          >
            保存并加载
          </button>
        </div>
      </div>
    )
  }
}

/** 内联错误提示 */
function ErrorInline({ message, onDismiss }: { message: string; onDismiss: () => void }): JSX.Element {
  return (
    <div className="llm-config-panel__error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>知道了</button>
    </div>
  )
}

import { useState } from 'react'
import {
  configureRuntimeConfig,
  hasEncryptedRuntimeConfig,
  unlockRuntimeConfig,
  readRuntimeConfigFromSession,
  clearRuntimeConfigSession,
} from '@/utils'

export function RuntimeConfigUnlockPanel() {
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'deepseek' | 'custom'>('openai')
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/chat/completions')
  const [model, setModel] = useState('gpt-4o-mini')
  const [apiKey, setApiKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [status, setStatus] = useState('未解锁')

  const runtimeConfig = readRuntimeConfigFromSession()

  const handleConfigure = async () => {
    if (!apiKey.trim() || !passphrase.trim() || !endpoint.trim()) {
      setStatus('请填写完整配置与口令')
      return
    }

    try {
      await configureRuntimeConfig({
        provider,
        endpoint,
        apiKey,
        model,
        passphrase,
      })
      setApiKey('')
      setStatus('配置已加密保存并解锁')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '配置失败')
    }
  }

  const handleUnlock = async () => {
    if (!passphrase.trim()) {
      setStatus('请输入口令')
      return
    }

    try {
      const config = await unlockRuntimeConfig(passphrase)
      setStatus(config ? '已解锁（仅本会话）' : '尚未发现加密配置')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '解锁失败')
    }
  }

  const handleLock = () => {
    clearRuntimeConfigSession()
    setStatus('会话已锁定')
  }

  return (
    <div className="panel runtime-config-panel">
      <h3>LLM 密钥解锁</h3>
      <p className="hint">每次启动需口令解锁，明文仅驻留当前会话内存。</p>

      <div className="runtime-config-grid">
        <label>
          供应商
          <select value={provider} onChange={event => setProvider(event.target.value as typeof provider)}>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="deepseek">deepseek</option>
            <option value="custom">custom</option>
          </select>
        </label>

        <label>
          端点
          <input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://..." />
        </label>

        <label>
          模型
          <input value={model} onChange={event => setModel(event.target.value)} placeholder="gpt-4o-mini" />
        </label>

        <label>
          API Key
          <input value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="sk-..." type="password" />
        </label>

        <label>
          口令
          <input value={passphrase} onChange={event => setPassphrase(event.target.value)} placeholder="输入解锁口令" type="password" />
        </label>
      </div>

      <div className="runtime-config-actions">
        <button className="btn btn-secondary" onClick={handleConfigure}>保存并解锁</button>
        <button className="btn btn-secondary" onClick={handleUnlock}>仅解锁</button>
        <button className="btn btn-secondary" onClick={handleLock}>锁定会话</button>
      </div>

      <p className="hint">状态：{status}</p>
      <p className="hint">本地密文：{hasEncryptedRuntimeConfig() ? '已存在' : '未配置'}，会话：{runtimeConfig ? '已解锁' : '未解锁'}</p>
    </div>
  )
}

/**
 * 错误横幅（ErrorBanner.tsx）— M3 错误四分类提示（全局）。
 *
 * 职责（对应重写计划「错误四分类提示」+ 审计教训「绝不把 ApiKey 失效误报为网络中断」）：
 * - 读 store.llmError（四分类已由 llm-service 判定），按 kind 显示差异化提示。
 * - ApiKey(401/403) → "API Key 失效，请检查密钥"
 * - Timeout → "请求超时，已重试/降级"
 * - Network → "网络异常，状态已保存"
 * - Degraded → "本回合降级结算（规则引擎）"
 * - Schema → "AI 输出格式异常，已兜底"
 *
 * 同时展示 store.userError（通用错误）。
 *
 * @module layers/ui/ErrorBanner
 */

import { type JSX } from 'react'
import { useGameStore } from '@/store/game-store'
import type { LlmErrorBanner } from '@/layers/application/services/llm-service'
import { Icon, type IconName } from '@/layers/ui/icons'

/** kind → CSS class + 图标（lucide SVG，可染色） */
const KIND_META: Record<LlmErrorBanner['kind'], { cls: string; icon: IconName }> = {
  api_key: { cls: 'error-banner--api-key', icon: 'key-round' }, // 🔑 → KeyRound
  timeout: { cls: 'error-banner--timeout', icon: 'clock' }, // ⏱ → Clock
  network: { cls: 'error-banner--network', icon: 'wifi' }, // 📡 → Wifi
  degraded: { cls: 'error-banner--degraded', icon: 'settings' }, // ⚙ → Settings（齿轮兜底）
  schema: { cls: 'error-banner--schema', icon: 'alert-triangle' }, // ⚠ → AlertTriangle
  server: { cls: 'error-banner--server', icon: 'alert-triangle' }, // ⚠ → AlertTriangle
}

/** kind → 用户可读建议（在主消息下方补充操作建议） */
const KIND_HINT: Record<LlmErrorBanner['kind'], string> = {
  api_key: '请打开 LLM 配置面板，检查 API Key 是否有效或已过期。',
  timeout: '已自动重试，超时则切规则引擎兜底，状态已保存。',
  network: '请检查网络连接；游戏状态已保存，可重试。',
  degraded: '导演部 LLM 不可用，本回合以规则引擎结算（无叙事润色）。',
  schema: 'AI 输出未通过格式校验，已兜底处理，不影响游戏推进。',
  server: 'LLM 服务端异常，请稍后重试。',
}

/**
 * 全局错误横幅组件（无错误时返回 null）。
 */
export default function ErrorBanner(): JSX.Element | null {
  const llmError = useGameStore((s) => s.llmError)
  const userError = useGameStore((s) => s.userError)
  const clearError = useGameStore((s) => s.clearError)

  if (llmError === null && userError === null) return null

  if (llmError !== null) {
    const meta = KIND_META[llmError.kind]
    return (
      <div className={`error-banner ${meta.cls}`} role="alert">
        <span className="error-banner__icon">
          <Icon name={meta.icon} size={18} />
        </span>
        <div className="error-banner__body">
          <strong>{llmError.message}</strong>
          <span className="error-banner__hint">{KIND_HINT[llmError.kind]}</span>
        </div>
        <button type="button" onClick={clearError} className="error-banner__dismiss">
          知道了
        </button>
      </div>
    )
  }

  // 通用 userError（非四分类）
  return (
    <div className="error-banner error-banner--generic" role="alert">
      <span className="error-banner__icon">
        <Icon name="alert-triangle" size={18} />
      </span>
      <div className="error-banner__body">
        <strong>{userError}</strong>
      </div>
      <button type="button" onClick={clearError} className="error-banner__dismiss">
        知道了
      </button>
    </div>
  )
}

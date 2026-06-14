/**
 * Web 模式检测（web-mode.ts）— 决定 gateway 是否走 mock 降级。
 *
 * 三态判定：
 * - **Tauri 生产**（`pnpm tauri dev` / 打包后窗口）：`isWebMode()` 为 **false**，
 *   gateway 全部走原 `invoke`（行为不变，零回归）。
 * - **vitest（jsdom）**：`isWebMode()` 为 **false**，
 *   gateway 走原 `invoke`（由测试模块的 mock 接管，原有 mock 不受影响）。
 * - **浏览器 vite dev**（`pnpm dev` 后浏览器打开 localhost:3000，
 *   供 agent-browser 验证）：`isWebMode()` 为 **true**，
 *   gateway 走 web-mock 实现（内存 fs + WebCrypto + 经 proxy 的真 DeepSeek）。
 *
 * 判定依据：
 * 1. 浏览器环境（`window` 与 `document` 均存在）；
 * 2. 非 Tauri runtime（无 `window.__TAURI_INTERNALS__`，Tauri 注入此全局）；
 * 3. 非 jsdom（vitest 用 jsdom，其 `navigator.userAgent` 含 `jsdom`）。
 *
 * **不 import `@tauri-apps/api`**（保持 gateway 边界：web-mock 文件零 Tauri 依赖）。
 *
 * @module layers/gateway/web-mode
 */

/**
 * 判定当前运行环境是否为「浏览器 vite dev」模式。
 *
 * Tauri runtime 会向 window 注入 `__TAURI_INTERNALS__`（IPC 入口）；
 * vitest 用 jsdom，其 navigator.userAgent 含 `jsdom`。两者均排除后，
 * 仅剩「真浏览器 + 非 Tauri」一态，即返回 true。
 *
 * @returns true=浏览器 vite dev（走 mock）；false=Tauri 生产 或 vitest（走 invoke）
 */
export function isWebMode(): boolean {
  // 非 window/document 环境（如 Node 直跑、Worker）：非 web 模式
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }
  // Tauri runtime：window.__TAURI_INTERNALS__ 由 Tauri 注入（IPC invoke 入口）
  // 见 @tauri-apps/api/core：invoke 内部读此全局，缺失则抛
  // "Cannot read properties of undefined (reading 'invoke')"。
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return false
  }
  // vitest 用 jsdom：navigator.userAgent 形如 "Mozilla/5.0 ... jsdom/20.0.0"
  const ua =
    typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : ''
  if (ua.includes('jsdom')) {
    return false
  }
  // 真 web 浏览器（agent-browser / 普通 Chrome 等）
  return true
}

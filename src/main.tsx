/**
 * 应用入口（React 19 挂载点）。
 *
 * 运行在 Tauri 2 WebView 中。挂载 #root，渲染 <App />。
 * Tauri 能力（fs/llm/crypto）一律经 @gateway/* 层封装调用，
 * 此处只做纯渲染挂载。
 *
 * @module main
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// 根容器（index.html 中的 #root）
const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('找不到根容器 #root，请检查 index.html')
}

// React 19 挂载（StrictMode 开发期双调用以暴露副作用问题）
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

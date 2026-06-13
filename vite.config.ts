import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Tauri 标准配置：检测是否运行在 `tauri dev` 下（前端端口由 Tauri 注入）
const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri 期望 env 前缀包含 TAURI_（让前端可读 Tauri 注入的环境变量）
  envPrefix: ['VITE_', 'TAURI_'],
  // Tauri dev 下保留 Rust 编译输出（不清屏）
  clearScreen: false,
  resolve: {
    // 六层目录落地后的完整 alias 集合
    alias: {
      '@': resolve(__dirname, './src'),
      '@components': resolve(__dirname, './src/components'),
      '@agents': resolve(__dirname, './src/agents'),
      '@game': resolve(__dirname, './src/game'),
      '@utils': resolve(__dirname, './src/utils'),
      '@types': resolve(__dirname, './src/types'),
      '@layers': resolve(__dirname, './src/layers'),
      '@gateway': resolve(__dirname, './src/layers/gateway'),
      '@workers': resolve(__dirname, './src/workers'),
    },
  },
  server: {
    port: 3000,
    // Tauri 必须固定端口（strictPort），否则窗口连不上 dev server
    strictPort: true,
    // Tauri dev 下通过 host 变量决定监听地址；web 单独 dev 仍可 open
    host: host || false,
    open: !host,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  // Worker 配置（用于物理引擎）
  worker: {
    format: 'es',
  },
  // Vitest 配置（继承自 vite.config；test.exclude 排除已废弃的 src-legacy 归档代码，
  // 与 tsconfig.json / eslint.config.js 的 exclude/ignores 对齐——src-legacy 仅借鉴不复用）
  test: {
    exclude: ['node_modules', 'dist', 'src-legacy', 'server'],
  },
})

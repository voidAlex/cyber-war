/// <reference types="vite/client" />

/**
 * Vite 环境类型声明。
 *
 * 游戏数据类型统一定义在 src/types/，本文件不再以全局 interface 声明
 * （避免与权威类型契约 src/types 冲突）。
 */

declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly MODE: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

// 确保 declare global 被视为模块
export {}

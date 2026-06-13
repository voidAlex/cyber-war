//! 赛博战争模拟器 — Tauri 2 构建脚本入口
//!
//! `tauri_build::build()` 会在编译期根据 `tauri.conf.json` / `capabilities/`
//! 生成必要的代码（如 capability 校验、图标符号链接等）。
//! 注意：当前缺少正式图标（`tauri.conf.json` 中图标路径留待 `tauri icon` 补全），
//! 这不阻塞 `cargo check`；后续用 `pnpm tauri icon <path>` 生成图标套件后即可打包。

fn main() {
    // 触发 Tauri 2 的标准构建流程（含 capabilities 校验）
    tauri_build::build()
}

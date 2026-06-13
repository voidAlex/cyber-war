//! 文件系统模块（赛博战争模拟器 Rust 后端 — 爪牙之一）
//!
//! 职责硬约束：**只做本地文件 IO，不解析游戏语义**。
//! 任何 command 里出现游戏规则计算即判违规。
//!
//! 子模块：
//! - [`atomic`]：原子写（临时文件 `.tmp` + rename），保证 world-state.json 等关键文件完整性
//! - [`append`]：真追加（`OpenOptions::append`，O(1)），用于 event-log.jsonl / diagnostics.log
//! - [`paths`]：用 `tauri::Manager::path` 解析 `app_data_dir`，saves 根 = `app_data_dir/saves`

pub mod append;
pub mod atomic;
pub mod paths;

// 重新导出常用项，方便上层 `use crate::fs::*`
pub use append::{append_bytes, append_line};
pub use atomic::{write_atomic, write_atomic_text};
pub use paths::{resolve_save_dir, resolve_saves_root, SaveDir};

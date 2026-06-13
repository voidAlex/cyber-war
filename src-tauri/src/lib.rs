//! 赛博战争模拟器 — Rust 后端库入口（Tauri 2）
//!
//! 模块组织（对应重写计划「Rust 后端」章节）：
//! - [`error`]：统一错误枚举 `AppError`（四分类）
//! - [`fs`]：文件 IO（原子写 / 真追加 / 路径解析），零业务逻辑
//! - [`crypto`]：加密原语（PBKDF2 + AES-256-GCM），明文即用即抛
//! - [`llm`]：LLM 转发（provider 路由 / SSRF 守卫 / 真流式 / 重试），不缓存 key
//! - [`commands`]：Tauri command 接口层（薄封装）

pub mod commands;
pub mod crypto;
pub mod error;
pub mod fs;
pub mod llm;

use commands::AppState;
use std::path::Path;

/// Tauri 应用运行入口（由 main.rs 调用）。
///
/// - 注册全部 command（fs_* / crypto_* / llm_*）。
/// - setup hook：初始化 saves 根目录（`<app_data_dir>/saves`）。
/// - 注入共享状态 `AppState`（LLM host 白名单）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            // 初始化 saves 根目录（不存在则创建）
            let saves_root = fs::resolve_saves_root(app.handle())?;
            if !Path::new(&saves_root).exists() {
                std::fs::create_dir_all(&saves_root).map_err(|e| {
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("创建 saves 根目录失败: {e}"),
                    )) as Box<dyn std::error::Error>
                })?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // fs 命令
            commands::fs_read_world_state,
            commands::fs_write_world_state,
            commands::fs_write_snapshot,
            commands::fs_append_event,
            commands::fs_read_event_log,
            commands::fs_write_faction_file,
            commands::fs_append_diagnostics,
            commands::fs_write_manifest,
            commands::fs_list_saves,
            commands::fs_init_save,
            commands::fs_delete_save,
            commands::fs_unpack_campaign,
            commands::fs_export_save,
            commands::fs_import_save,
            // crypto 命令
            commands::crypto_encrypt_api_key,
            commands::crypto_decrypt_api_key,
            // llm 命令
            commands::llm_stream_forward,
            commands::llm_set_allowed_hosts,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

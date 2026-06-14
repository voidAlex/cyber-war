//! 赛博战争模拟器 — Rust 后端库入口（Tauri 2）
//!
//! 模块组织（对应重写计划「Rust 后端」章节）：
//! - [`error`]：统一错误枚举 `AppError`（四分类）
//! - [`fs`]：文件 IO（原子写 / 真追加 / 路径解析），零业务逻辑
//! - [`keyring_store`]：apiKey 经 OS 凭证库存取（去口令改造，替代旧 crypto/）
//! - [`llm`]：LLM 转发（provider 路由 / SSRF 守卫 / 真流式 / 重试），不缓存 key
//! - [`commands`]：Tauri command 接口层（薄封装）

pub mod commands;
pub mod error;
pub mod fs;
pub mod keyring_store;
pub mod llm;

use commands::AppState;
use std::path::Path;

/// Tauri 应用运行入口（由 main.rs 调用）。
///
/// - 注册全部 command（fs_* / llm_key_* / llm_config_* / llm_*）。
/// - setup hook：初始化 saves 根目录（`<app_data_dir>/saves`）与
///   config 根目录（`<app_data_dir>/config`，apiKey 降级明文落盘前置）。
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
            // 初始化 config 根目录（不存在则创建）
            // 去口令改造：apiKey 降级明文 / LLM 配置都落在此目录下
            let config_root = fs::resolve_config_root(app.handle())?;
            if !Path::new(&config_root).exists() {
                std::fs::create_dir_all(&config_root).map_err(|e| {
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("创建 config 根目录失败: {e}"),
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
            commands::fs_read_snapshot,
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
            // llm key / config 命令（去口令改造：apiKey 经 OS 凭证库）
            commands::llm_key_save,
            commands::llm_key_load,
            commands::llm_key_delete,
            commands::llm_config_read,
            commands::llm_config_write,
            // llm 命令
            commands::llm_stream_forward,
            commands::llm_set_allowed_hosts,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}

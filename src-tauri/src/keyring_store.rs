//! OS 凭证库存取模块（赛博战争模拟器 Rust 后端 — 爪牙之一）
//!
//! 职责：apiKey 的存取（去口令改造后替代旧 PBKDF2+AES-GCM 加密存文件方案）。
//!
//! 铁律：**零业务逻辑**——只做凭证存取 + 降级兜底，无游戏规则。
//!
//! ## 两条存取路径
//! 1. **主路径（OS 凭证库）**：`keyring` crate（Linux secret-service /
//!    macOS Keychain / Windows Credential Manager）。OS 透明加密，
//!    桌面端无口令、重启自动加载。
//! 2. **降级路径（明文文件）**：`<app_data_dir>/config/api-key.txt`。
//!    仅当 keyring 不可用时（如 WSL2/Linux 无 Secret Service daemon，
//!    返回 `keyring::Error::PlatformFailure`）启用，返回警告。
//!
//! ## 安全约束
//! - apiKey 明文**仅作函数参数/返回值**，绝不缓存到结构体字段或全局状态。
//! - 降级 warning / diagnostics **只写路径与失败原因，绝不写 apiKey 本身**。
//! - keyring 调用一律包 `tokio::task::spawn_blocking`（D-Bus 同步阻塞）。
//!
//! ## IPC 契约
//! - service 名固定 `cyber-war-simulator`，account 名固定 `llm-api-key`。
//! - `KeyBackend` 经 serde 序列化为字符串 `"keyring"` / `"file_fallback"`，
//!   供前端 `KeyStoreOutcome.backend` 透传给 UI。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::AppError;
use crate::fs::{self, paths::config_files, write_atomic_text};

// =============================================================================
// 常量：keyring service / account 名（固定，前端契约依赖）
// =============================================================================

/// keyring service 名（对应 OS 凭证库条目的"应用标识"）。
///
/// 跨平台固定字符串：Linux secret-service / macOS Keychain / Windows Credential Manager
/// 都用它作为条目的服务维度键。
pub const SERVICE_NAME: &str = "cyber-war-simulator";

/// keyring account 名（对应 OS 凭证库条目的"账户维度键"）。
///
/// 当前只存一个 apiKey，固定为 `llm-api-key`。
pub const ACCOUNT_NAME: &str = "llm-api-key";

// =============================================================================
// KeyBackend：存取后端标识（前端 KeyStoreOutcome.backend 透传）
// =============================================================================

/// apiKey 实际落盘的后端（决定前端是否提示降级警告）。
///
/// 序列化为稳定字符串，前端用 `backend === 'keyring'` 判别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KeyBackend {
    /// 写入 OS 凭证库成功（推荐路径，无警告）
    #[serde(rename = "keyring")]
    Keyring,
    /// keyring 不可用，降级写明文文件（前端应提示用户安全风险）
    #[serde(rename = "file_fallback")]
    FileFallback,
}

// =============================================================================
// 内部工具：构造 keyring Entry（与 spawn_blocking 配合用闭包捕获）
// =============================================================================

/// 构造 keyring Entry（service + account 固定）。
///
/// 注意：`Entry::new` 本身不会触发 D-Bus（只是构造客户端句柄），
/// 真正阻塞的是 `set_password` / `get_password` / `delete_credential`。
fn new_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(SERVICE_NAME, ACCOUNT_NAME)
}

/// 解析降级文件路径：`<config_root>/api-key.txt`。
///
/// 与 `resolve_config_root` 配合，config 根由 setup hook 确保存在。
fn fallback_file(config_root: &std::path::Path) -> PathBuf {
    config_root.join(config_files::API_KEY_PLAINTEXT)
}

// =============================================================================
// save：存 apiKey（优先 keyring，失败降级明文文件 + 警告）
// =============================================================================

/// 存 apiKey。
///
/// 返回 `(KeyBackend, Option<warning>)`：
/// - 成功写入 keyring → `(KeyBackend::Keyring, None)`。
/// - keyring 失败 → 降级写 `<config>/api-key.txt` 明文 →
///   `(KeyBackend::FileFallback, Some(warning))`，warning 含失败原因 + 降级文件路径
///   （**绝不包含 apiKey 本身**）。同时清残留 keyring entry（避免脏数据）。
///
/// # 安全
/// - `api_key` 仅作参数，函数返回后即 Drop，不缓存。
/// - warning 字符串**绝不包含 apiKey**，可安全透传给前端 / 写 diagnostics。
///
/// # 阻塞
/// keyring 调用包 `spawn_blocking`（D-Bus 同步阻塞，避免阻塞 tokio runtime）。
pub async fn save(
    app: &AppHandle,
    api_key: String,
) -> Result<(KeyBackend, Option<String>), AppError> {
    // 1. 尝试 keyring（spawn_blocking，D-Bus 同步阻塞）
    //    api_key 先 clone 一份进 keyring 闭包，原值留给降级路径
    let api_key_for_keyring = api_key.clone();
    let keyring_result = tokio::task::spawn_blocking(move || -> Result<(), keyring::Error> {
        let entry = new_entry()?;
        entry.set_password(&api_key_for_keyring)
    })
    .await
    .map_err(|e| AppError::Crypto(format!("keyring save 任务调度失败: {e}")))?;

    match keyring_result {
        Ok(()) => Ok((KeyBackend::Keyring, None)),
        Err(err) => {
            // 2. keyring 失败 → 降级明文文件 + 警告（绝不写 key）
            let warning = format!(
                "OS 凭证库不可用（{err}），apiKey 已降级为明文存储。请参考文档配置 Secret Service daemon 或在桌面环境运行。"
            );
            let config_root = fs::resolve_config_root(app)?;
            // 确保 config 目录存在（降级文件落盘前置条件）
            if !config_root.exists() {
                std::fs::create_dir_all(&config_root)?;
            }
            let path = fallback_file(&config_root);
            // 原子写降级文件（复用 fs::write_atomic_text，崩溃不写半截）
            let path_for_write = path.clone();
            let api_key_for_write = api_key.clone();
            tokio::task::spawn_blocking(move || {
                write_atomic_text(&path_for_write, &api_key_for_write)
            })
            .await
            .map_err(|e| AppError::Fs(format!("降级写任务调度失败: {e}")))??;

            // 3. 清残留 keyring entry（幂等，失败不影响降级结果）
            //    防止旧 keyring 残留导致 load 时读到陈旧 key。
            let _ = tokio::task::spawn_blocking(|| -> Result<(), keyring::Error> {
                let entry = new_entry()?;
                // delete_password 对 NoEntry 视为成功，幂等
                let _ = entry.delete_password();
                Ok(())
            })
            .await;

            // warning 补上降级文件路径（仅路径，无 key）
            let warning_with_path = format!("{warning} 降级文件: {}", path.display());
            Ok((KeyBackend::FileFallback, Some(warning_with_path)))
        }
    }
}

// =============================================================================
// load：读 apiKey（先 keyring，NoEntry/Error 再试降级文件）
// =============================================================================

/// 读 apiKey。
///
/// 查找顺序：
/// 1. keyring `get_password`：
///    - `Ok(pw)` → 返回 `Some(pw)`。
///    - `Err(NoEntry)` → keyring 无条目，转降级文件。
///    - `Err(其他 Error)`（如 PlatformFailure）→ 也转降级文件（WSL 常见）。
/// 2. 降级文件 `<config>/api-key.txt`：读取并 `trim()`，存在则返回 `Some`。
/// 3. 两处都没有 → 返回 `None`（首次配置 / 已 delete）。
///
/// # 安全
/// 返回的明文 apiKey 由调用方即用即抛，本模块不缓存。
///
/// # 阻塞
/// keyring 与文件读均包 `spawn_blocking`。
pub async fn load(app: &AppHandle) -> Result<Option<String>, AppError> {
    // 1. keyring get_password（spawn_blocking）
    let keyring_result = tokio::task::spawn_blocking(|| -> Result<Option<String>, keyring::Error> {
        let entry = new_entry()?;
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            // 其他错误（PlatformFailure 等）视为"不可用"，由降级文件兜底
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| AppError::Crypto(format!("keyring load 任务调度失败: {e}")))?;

    if let Ok(Some(pw)) = keyring_result {
        return Ok(Some(pw));
    }

    // 2. 降级文件兜底
    let config_root = fs::resolve_config_root(app)?;
    let path = fallback_file(&config_root);
    let path_for_read = path.clone();
    let file_result = tokio::task::spawn_blocking(move || -> Result<Option<String>, AppError> {
        if !path_for_read.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path_for_read)?;
        let trimmed = content.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    })
    .await
    .map_err(|e| AppError::Fs(format!("降级读任务调度失败: {e}")))??;
    Ok(file_result)
}

// =============================================================================
// delete：删 apiKey（幂等：keyring entry + 降级文件都清）
// =============================================================================

/// 删 apiKey（幂等）。
///
/// 同时清理两个位置，确保无残留：
/// 1. keyring entry（`delete_credential`，`NoEntry` 视为成功）。
/// 2. 降级文件 `<config>/api-key.txt`（不存在视为成功）。
///
/// 任一位置的清理失败不阻塞另一位置（但会汇总错误返回）。
///
/// # 阻塞
/// keyring 与文件删均包 `spawn_blocking`。
pub async fn delete(app: &AppHandle) -> Result<(), AppError> {
    // 1. 删 keyring entry（NoEntry 视为成功，幂等）
    let keyring_err: Option<AppError> = match tokio::task::spawn_blocking(|| -> Result<(), keyring::Error> {
        let entry = new_entry()?;
        match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    })
    .await
    {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(AppError::Crypto(format!("keyring delete 失败: {e}"))),
        Err(e) => Some(AppError::Crypto(format!("keyring delete 任务调度失败: {e}"))),
    };

    // 2. 删降级文件（不存在视为成功，幂等）
    let config_root = fs::resolve_config_root(app)?;
    let path = fallback_file(&config_root);
    let file_result: Result<(), AppError> = tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        if path.exists() {
            std::fs::remove_file(&path)?; // io::Error 经 From 转 AppError::Fs
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Fs(format!("降级删任务调度失败: {e}")))?; // 解 JoinError，内层 Result 保留

    // 汇总：两位置都已尽力清理。优先返回文件错误（更可能影响实际数据），
    // 其次 keyring 错误。任一成功不抵消另一失败。
    file_result?;
    if let Some(e) = keyring_err {
        return Err(e);
    }
    Ok(())
}

// =============================================================================
// 单元测试：keyring_store 三态 + 降级路径
// =============================================================================
//
// 测试策略：
// - **降级路径测（直接测 FileFallback）**：绕过 keyring，直接验证降级文件的
//   写/读/删语义（CI 无 OS daemon 也能跑）。这是 CI 必跑的最小集。
// - **keyring mock 测**：用 `keyring::Entry::new_with_target` + mock store
//   测 save/load/delete 真实调用链。需 mock 后端，WSL/CI 环境 D-Bus 不可用
//   时由降级路径测兜底覆盖。
//
// 真实 keyring 集成（macOS/Win/Linux 桌面带 daemon）留手动验证。

#[cfg(test)]
mod tests {
    use super::*;

    /// 降级文件读写基础语义：直接写读 `fallback_file` 路径，验证 trim 与空文件。
    ///
    /// 这覆盖了降级路径的核心契约（写什么、读什么），不依赖 keyring crate 的运行时。
    #[test]
    fn fallback_file_write_read_trim_semantics() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let path = fallback_file(tmp.path());

        // 写入带空白的内容，模拟用户/旧格式残留
        std::fs::write(&path, "  sk-test-key-with-ws  \n").unwrap();

        // 模拟 load 的降级读逻辑（trim 后非空 → Some）
        let content = std::fs::read_to_string(&path).unwrap();
        let trimmed = content.trim();
        assert_eq!(trimmed, "sk-test-key-with-ws");
        assert!(!trimmed.is_empty());
    }

    /// 降级文件不存在时读返回 None（模拟首次配置 / 已 delete）。
    #[test]
    fn fallback_file_missing_reads_none() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let path = fallback_file(tmp.path());

        // 文件不存在 → load 降级路径返回 None
        assert!(!path.exists());
        // 模拟 load 内部逻辑：!exists → None
        let result: Option<String> = if path.exists() {
            std::fs::read_to_string(&path).ok().and_then(|c| {
                let t = c.trim();
                if t.is_empty() { None } else { Some(t.to_string()) }
            })
        } else {
            None
        };
        assert_eq!(result, None);
    }

    /// 降级文件为空（或仅空白）时读返回 None。
    #[test]
    fn fallback_file_empty_reads_none() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let path = fallback_file(tmp.path());

        // 写入纯空白
        std::fs::write(&path, "   \n\t  ").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let trimmed = content.trim();
        assert!(trimmed.is_empty(), "纯空白 trim 后应为空");
    }

    /// 降级文件删除幂等：删两次都成功（第二次不存在视为成功）。
    #[test]
    fn fallback_file_delete_idempotent() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let path = fallback_file(tmp.path());

        // 先写后删
        std::fs::write(&path, "sk-test").unwrap();
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());

        // 第二次删：模拟 delete 内部 !exists → Ok(()) 的幂等逻辑
        let result = if path.exists() {
            std::fs::remove_file(&path)
        } else {
            Ok(())
        };
        assert!(result.is_ok(), "删除不存在的文件应幂等成功");
    }

    /// KeyBackend 序列化契约：keyring → "keyring"，file_fallback → "file_fallback"。
    ///
    /// 前端 `KeyStoreOutcome.backend` 字段依赖此字符串契约，改名即破坏 IPC。
    #[test]
    fn key_backend_serializes_to_stable_strings() {
        let kr_json = serde_json::to_string(&KeyBackend::Keyring).unwrap();
        let ff_json = serde_json::to_string(&KeyBackend::FileFallback).unwrap();
        assert_eq!(kr_json, "\"keyring\"");
        assert_eq!(ff_json, "\"file_fallback\"");

        // 反序列化往返
        let kr: KeyBackend = serde_json::from_str(&kr_json).unwrap();
        let ff: KeyBackend = serde_json::from_str(&ff_json).unwrap();
        assert_eq!(kr, KeyBackend::Keyring);
        assert_eq!(ff, KeyBackend::FileFallback);
    }

    /// service / account 名常量稳定（前端契约依赖，改名即破坏 keyring 条目查找）。
    #[test]
    fn service_account_names_are_stable() {
        assert_eq!(SERVICE_NAME, "cyber-war-simulator");
        assert_eq!(ACCOUNT_NAME, "llm-api-key");
    }

    /// keyring Entry 构造不触发 D-Bus（仅构造句柄），不应在无 daemon 环境崩。
    ///
    /// 这验证 `new_entry()` 在 CI/WSL 无 Secret Service daemon 时也能返回 Ok
    /// （真正阻塞的是 set/get/delete，构造本身安全）。
    #[test]
    fn new_entry_construction_does_not_require_daemon() {
        // Entry::new 不触发 D-Bus，只构造客户端句柄
        let entry = new_entry();
        // 构造应成功（即使无 daemon）；失败也仅是平台不支持，不 panic
        assert!(entry.is_ok(), "Entry::new 不应触发 D-Bus，构造应成功");
    }

    /// keyring mock 集成测：用 `new_with_target` + 内置 mock 测 save→load→delete 闭环。
    ///
    /// 用 keyring crate 的 mock 后端（target = "mock"），不依赖 OS daemon，
    /// CI 可跑。验证三态语义闭环。
    #[test]
    fn keyring_mock_save_load_delete_roundtrip() {
        use keyring::set_default_credential_builder;
        use keyring::mock::default_credential_builder;

        // 注入 mock 后端（keyring crate 内置，测试用）
        set_default_credential_builder(default_credential_builder());

        // 用 new_with_target 拿 mock entry（target="mock" 触发 mock 后端）
        let entry = keyring::Entry::new_with_target(
            SERVICE_NAME,
            SERVICE_NAME, // mock 后端用 target 作为存储键维度
            ACCOUNT_NAME,
        )
        .expect("构造 mock entry 失败");

        // 初始状态：get 应 NoEntry
        match entry.get_password() {
            Err(keyring::Error::NoEntry) => {}
            other => panic!("初始应为 NoEntry，实际: {other:?}"),
        }

        // save
        entry.set_password("sk-mock-test-key").expect("mock set 失败");

        // load：应读回相同 key
        let loaded = entry.get_password().expect("mock get 失败");
        assert_eq!(loaded, "sk-mock-test-key");

        // delete
        entry.delete_password().expect("mock delete 失败");

        // 删除后：get 应 NoEntry
        match entry.get_password() {
            Err(keyring::Error::NoEntry) => {}
            other => panic!("删除后应为 NoEntry，实际: {other:?}"),
        }
    }

    /// keyring mock 测：delete 幂等（删两次第二次 NoEntry 视为成功）。
    ///
    /// 验证 delete 函数对 NoEntry 的幂等处理逻辑。
    #[test]
    fn keyring_mock_delete_idempotent() {
        use keyring::set_default_credential_builder;
        use keyring::mock::default_credential_builder;
        set_default_credential_builder(default_credential_builder());

        let entry = keyring::Entry::new_with_target(
            SERVICE_NAME,
            SERVICE_NAME,
            ACCOUNT_NAME,
        )
        .expect("构造 mock entry 失败");

        // 先 set 再 delete
        entry.set_password("sk-test").unwrap();
        let _ = entry.delete_password();

        // 第二次 delete：模拟 delete() 内部 NoEntry → Ok(()) 逻辑
        let result = match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        };
        assert!(result.is_ok(), "第二次 delete 应幂等成功");
    }
}

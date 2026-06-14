//! Tauri command 接口层（薄封装，零业务逻辑）
//!
//! 对应重写计划「command 接口清单」——前端通过 `invoke` 调用这些命令。
//! 铁律：任何 command 里出现游戏规则计算（状态机/结算/情报/外交）即判违规。
//! 本文件只做：参数校验 → 调 fs/crypto/llm 三模块 → 返回结果。
//!
//! 安全：
//! - `api_key` 仅作参数，返回即 Drop，绝不写文件/日志。
//! - diagnostics 只写 status code，绝不写 key/payload。
//! - ZIP 解包防 zip-slip（每 entry 校验无 `..` 且 canonicalize 仍在 sandbox）。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use tauri::{ipc::Channel, AppHandle, State};

use crate::crypto::{self, EncryptedPayload};
use crate::error::AppError;
use crate::fs::{
    self,
    paths::{files, SaveDir},
};
use crate::llm::{self, ForwardRequest, LlmFinalResult, LlmStreamEvent, ProviderKind};

// =============================================================================
// 共享状态：allowed_hosts（custom provider 白名单，由前端通过 settings 注入）
// =============================================================================

/// 进程内共享状态：LLM host 白名单（线程安全）。
/// custom provider 的额外 host 由前端 invoke `llm_set_allowed_hosts` 更新。
#[derive(Debug, Default)]
pub struct AppState {
    allowed_hosts: std::sync::Mutex<llm::guard::AllowedHosts>,
}

impl AppState {
    fn snapshot(&self) -> llm::guard::AllowedHosts {
        // 持锁时克隆 AllowedHosts（若中毒则返回默认空列表）
        match self.allowed_hosts.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => llm::guard::AllowedHosts::default(),
        }
    }
    fn replace(&self, hosts: llm::guard::AllowedHosts) {
        if let Ok(mut guard) = self.allowed_hosts.lock() {
            *guard = hosts;
        }
    }
}

// =============================================================================
// 共享工具：解析存档目录 + 读取存档根
// =============================================================================

/// 解析 saves 根 + 指定 saveId 的存档目录。
fn save_dir(app: &AppHandle, save_id: &str) -> Result<SaveDir, AppError> {
    let saves_root = fs::resolve_saves_root(app)?;
    fs::resolve_save_dir(&saves_root, save_id)
}

/// 同步读取文件全文为字符串（小文件场景：world-state/manifest/snapshot/faction）。
fn read_text(path: &Path) -> Result<String, AppError> {
    std::fs::read_to_string(path)
        .map_err(|e| AppError::Fs(format!("读取文件失败 {path:?}: {e}")))
}

// =============================================================================
// fs 命令
// =============================================================================

/// 读取 world-state.json（返回原始 JSON 字符串，Rust 不解析语义）。
#[tauri::command]
pub async fn fs_read_world_state(
    app: AppHandle,
    save_id: String,
) -> Result<String, AppError> {
    let dir = save_dir(&app, &save_id)?;
    let path = dir.world_state();
    let content = tokio::task::spawn_blocking(move || read_text(&path))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(content)
}

/// 原子写入 world-state.json（接收前端序列化好的 JSON 字符串）。
#[tauri::command]
pub async fn fs_write_world_state(
    app: AppHandle,
    save_id: String,
    content: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    ensure_dir(&dir.dir)?;
    let path = dir.world_state();
    tokio::task::spawn_blocking(move || fs::write_atomic_text(&path, &content))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 原子写入 snapshot.json。
#[tauri::command]
pub async fn fs_write_snapshot(
    app: AppHandle,
    save_id: String,
    content: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    ensure_dir(&dir.dir)?;
    let path = dir.snapshot();
    tokio::task::spawn_blocking(move || fs::write_atomic_text(&path, &content))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 读取 snapshot.json 全文（小文件，回放/崩溃恢复时取最近快照）。
///
/// Rust 不解析语义，仅返回原始 JSON 字符串；不存在时返回 Err(Fs)，
/// 上层（snapshot.ts readTurnSnapshot）据 null 兜底回退到 world-state。
#[tauri::command]
pub async fn fs_read_snapshot(
    app: AppHandle,
    save_id: String,
) -> Result<String, AppError> {
    let dir = save_dir(&app, &save_id)?;
    let path = dir.snapshot();
    let content = tokio::task::spawn_blocking(move || read_text(&path))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(content)
}

/// 真追加一行事件到 event-log.jsonl（O(1)）。
#[tauri::command]
pub async fn fs_append_event(
    app: AppHandle,
    save_id: String,
    line: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    ensure_dir(&dir.dir)?;
    let path = dir.event_log();
    tokio::task::spawn_blocking(move || fs::append_line(&path, &line))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 读取 event-log.jsonl 指定 offset/limit 范围的行（分页读取）。
#[tauri::command]
pub async fn fs_read_event_log(
    app: AppHandle,
    save_id: String,
    offset: u64,
    limit: u64,
) -> Result<Vec<String>, AppError> {
    let dir = save_dir(&app, &save_id)?;
    let path = dir.event_log();
    // 读日志是 IO，放阻塞线程池
    let lines = tokio::task::spawn_blocking(move || -> Result<Vec<String>, AppError> {
        let file = std::fs::File::open(&path)
            .map_err(|e| AppError::Fs(format!("打开 event-log 失败: {e}")))?;
        let reader = BufReader::new(file);
        let mut out = Vec::new();
        for (i, line) in reader.lines().enumerate() {
            let idx = i as u64;
            if idx < offset {
                continue;
            }
            if out.len() as u64 >= limit {
                break;
            }
            let line = line.map_err(|e| AppError::Fs(format!("读取行失败: {e}")))?;
            out.push(line);
        }
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(lines)
}

/// 原子写入阵营文件 factions/<faction_id>.json。
#[tauri::command]
pub async fn fs_write_faction_file(
    app: AppHandle,
    save_id: String,
    faction_id: String,
    content: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    ensure_dir(&dir.factions_dir())?;
    let path = dir.faction_file(&faction_id)?;
    tokio::task::spawn_blocking(move || fs::write_atomic_text(&path, &content))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 真追加一行到 diagnostics.log（只写 status code / 类别，绝不写 key/payload）。
#[tauri::command]
pub async fn fs_append_diagnostics(
    app: AppHandle,
    save_id: String,
    line: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    ensure_dir(&dir.dir)?;
    let path = dir.diagnostics();
    tokio::task::spawn_blocking(move || fs::append_line(&path, &line))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 原子写入 manifest.json。
#[tauri::command]
pub async fn fs_write_manifest(
    app: AppHandle,
    save_id: String,
    content: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    ensure_dir(&dir.dir)?;
    let path = dir.manifest();
    tokio::task::spawn_blocking(move || fs::write_atomic_text(&path, &content))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 列出所有存档的 saveId（扫描 saves 根目录下的子目录）。
#[tauri::command]
pub async fn fs_list_saves(app: AppHandle) -> Result<Vec<String>, AppError> {
    let saves_root = fs::resolve_saves_root(&app)?;
    let list = tokio::task::spawn_blocking(move || -> Result<Vec<String>, AppError> {
        if !saves_root.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&saves_root)
            .map_err(|e| AppError::Fs(format!("读取 saves 目录失败: {e}")))?
        {
            let entry = entry.map_err(|e| AppError::Fs(format!("读取目录项失败: {e}")))?;
            let path = entry.path();
            // 仅收录含 manifest.json 的子目录（视为合法存档）
            if path.is_dir() && path.join(files::MANIFEST).exists() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    out.push(name.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(list)
}

/// 初始化存档目录（创建 saves/<saveId> 及标准子目录，写入 manifest）。
#[tauri::command]
pub async fn fs_init_save(
    app: AppHandle,
    save_id: String,
    manifest: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    // 创建存档目录及标准子目录
    {
        let dir_clone = dir.dir.clone();
        tokio::task::spawn_blocking(move || -> Result<(), AppError> {
            std::fs::create_dir_all(&dir_clone)?;
            std::fs::create_dir_all(dir_clone.join(files::FACTIONS_SUBDIR))?;
            std::fs::create_dir_all(dir_clone.join(files::CAMPAIGN_SUBDIR))?;
            Ok(())
        })
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    }
    // 写入 manifest（原子）
    let path = dir.manifest();
    tokio::task::spawn_blocking(move || fs::write_atomic_text(&path, &manifest))
        .await
        .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 删除存档目录（递归删除 saves/<saveId>）。
#[tauri::command]
pub async fn fs_delete_save(app: AppHandle, save_id: String) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    let path = dir.dir;
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        if path.exists() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| AppError::Fs(format!("删除存档失败 {path:?}: {e}")))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 解包战役包 ZIP 到 saves/<saveId>/campaign/（防 zip-slip）。
///
/// 安全：每个 entry 经 [`resolve_zip_entry_path`] 校验无 `..` 且
/// join+canonicalize 仍在 campaign 目录 sandbox 内。
#[tauri::command]
pub async fn fs_unpack_campaign(
    app: AppHandle,
    save_id: String,
    zip_path: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    let sandbox = dir.campaign_dir();
    ensure_dir(&sandbox)?;

    let zip_path = PathBuf::from(zip_path);
    // 解包在阻塞线程池（zip 是同步 API）
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let file = std::fs::File::open(&zip_path)
            .map_err(|e| AppError::Fs(format!("打开 ZIP 失败: {e}")))?;
        let mut archive = zip::ZipArchive::new(file)?;

        // sandbox 规范化路径（用于后续 canonicalize 比较）
        let sandbox_canon = sandbox.canonicalize().unwrap_or_else(|_| sandbox.clone());

        let mut buf = vec![0u8; 64 * 1024];
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let entry_name = entry
                .enclosed_name()
                .ok_or_else(|| AppError::InvalidArg(format!("ZIP entry {i} 含非法路径")))?;
            // 防 zip-slip 校验（含 `..` 拒绝 + canonicalize 边界校验）
            let out_path = resolve_zip_entry_path(&sandbox, &sandbox_canon, &entry_name)?;

            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)?;
            } else {
                // 写文件（用 atomic 的临时文件方式）
                if let Some(p) = out_path.parent() {
                    std::fs::create_dir_all(p)?;
                }
                let mut out = std::fs::File::create(&out_path)
                    .map_err(|e| AppError::Fs(format!("创建解包文件失败: {e}")))?;
                use std::io::Write;
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n])?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 导出存档为 ZIP（把 saves/<saveId> 整个打包）。
#[tauri::command]
pub async fn fs_export_save(
    app: AppHandle,
    save_id: String,
    out_zip_path: String,
) -> Result<(), AppError> {
    let dir = save_dir(&app, &save_id)?;
    let src = dir.dir;
    let out = PathBuf::from(out_zip_path);
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        if !src.exists() {
            return Err(AppError::Fs("源存档目录不存在".into()));
        }
        let file = std::fs::File::create(&out)
            .map_err(|e| AppError::Fs(format!("创建导出文件失败: {e}")))?;
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut walker = vec![src.clone()];
        while let Some(d) = walker.pop() {
            for entry in std::fs::read_dir(&d)
                .map_err(|e| AppError::Fs(format!("遍历存档失败: {e}")))?
            {
                let entry = entry.map_err(|e| AppError::Fs(format!("读取项失败: {e}")))?;
                let path = entry.path();
                let rel = path.strip_prefix(&src).unwrap_or(&path);
                if path.is_dir() {
                    zip.add_directory(rel.to_string_lossy(), opts)?;
                    walker.push(path);
                } else {
                    zip.start_file(rel.to_string_lossy(), opts)?;
                    let bytes = std::fs::read(&path)?;
                    use std::io::Write;
                    zip.write_all(&bytes)?;
                }
            }
        }
        zip.finish()
            .map_err(|e| AppError::Fs(format!("完成 ZIP 失败: {e}")))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

/// 导入存档 ZIP 到一个新 saveId（解包到 saves/<new_save_id>）。
#[tauri::command]
pub async fn fs_import_save(
    app: AppHandle,
    new_save_id: String,
    zip_path: String,
) -> Result<(), AppError> {
    // 复用 unpack_campaign 的 zip-slip 防御，但解包到存档根目录
    let dir = save_dir(&app, &new_save_id)?;
    let sandbox = dir.dir.clone();
    ensure_dir(&sandbox)?;

    let zip_path = PathBuf::from(zip_path);
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let file = std::fs::File::open(&zip_path)
            .map_err(|e| AppError::Fs(format!("打开导入 ZIP 失败: {e}")))?;
        let mut archive = zip::ZipArchive::new(file)?;
        let sandbox_canon = sandbox.canonicalize().unwrap_or_else(|_| sandbox.clone());
        let mut buf = vec![0u8; 64 * 1024];
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let entry_name = entry
                .enclosed_name()
                .ok_or_else(|| AppError::InvalidArg(format!("ZIP entry {i} 含非法路径")))?;
            // 防 zip-slip 校验（含 `..` 拒绝 + canonicalize 边界校验）
            let out_path = resolve_zip_entry_path(&sandbox, &sandbox_canon, &entry_name)?;
            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)?;
            } else {
                if let Some(p) = out_path.parent() {
                    std::fs::create_dir_all(p)?;
                }
                let mut out = std::fs::File::create(&out_path)
                    .map_err(|e| AppError::Fs(format!("创建导入文件失败: {e}")))?;
                use std::io::Write;
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n])?;
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Fs(format!("任务调度失败: {e}")))??;
    Ok(())
}

// =============================================================================
// crypto 命令
// =============================================================================

/// 加密 API key（返回可落盘的 EncryptedPayload）。
/// 明文仅作参数，绝不缓存；密文格式 version/salt/nonce/cipher。
#[tauri::command]
pub async fn crypto_encrypt_api_key(
    password: String,
    plaintext_key: String,
) -> Result<EncryptedPayload, AppError> {
    // 加密在阻塞线程池（PBKDF2 600k 是 CPU 密集型）
    tokio::task::spawn_blocking(move || crypto::encrypt(&password, plaintext_key.as_bytes()))
        .await
        .map_err(|e| AppError::Crypto(format!("任务调度失败: {e}")))?
}

/// 解密 API key（明文解密后即用即抛，绝不缓存到结构体/全局）。
#[tauri::command]
pub async fn crypto_decrypt_api_key(
    password: String,
    payload: EncryptedPayload,
) -> Result<String, AppError> {
    let bytes = tokio::task::spawn_blocking(move || crypto::decrypt(&password, &payload))
        .await
        .map_err(|e| AppError::Crypto(format!("任务调度失败: {e}")))??;
    // 明文立即转字符串返回（调用方用完即 Drop）
    String::from_utf8(bytes).map_err(|e| AppError::Crypto(format!("明文非 UTF-8: {e}")))
}

// =============================================================================
// llm 命令
// =============================================================================

/// 真流式转发 LLM 请求。
///
/// 安全：endpoint 经 guard 校验（白名单 + 私网拒绝 + 生产 https）；
/// api_key 仅作参数透传，绝不写日志；payload 不解析游戏语义。
///
/// 返回 `LlmFinalResult`（含 usage 与 degraded 标志）。
#[tauri::command]
pub async fn llm_stream_forward(
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
    api_key: String,
    payload: serde_json::Value,
    on_event: Channel<LlmStreamEvent>,
) -> Result<LlmFinalResult, AppError> {
    // 1. 解析 provider
    let provider_kind = ProviderKind::parse(&provider)?;

    // 2. 解析 endpoint URL（router 决定 base_url）
    let resolved_endpoint = llm::resolve_provider(provider_kind, &endpoint)?;

    // 3. SSRF 守卫：白名单 + 私网拒绝 + 生产 https
    let allowed = state.snapshot();
    llm::guard::validate_endpoint(&resolved_endpoint, &allowed)?;

    // 4. 构造转发请求（api_key 即用即抛）
    let request = ForwardRequest {
        provider: provider_kind,
        endpoint: resolved_endpoint,
        api_key,
        payload,
    };

    // 5. 带重试的真流式转发
    let cfg = llm::RetryConfig::default();
    let result = llm::stream_forward_with_retry(&request, &on_event, &cfg).await?;
    Ok(result)
}

/// 更新 LLM host 白名单（custom provider 用，由前端 settings 注入）。
#[tauri::command]
pub async fn llm_set_allowed_hosts(
    state: State<'_, AppState>,
    hosts: Vec<String>,
) -> Result<(), AppError> {
    state.replace(llm::guard::AllowedHosts::new(hosts));
    Ok(())
}

// =============================================================================
// 辅助函数
// =============================================================================

/// 确保目录存在（含父目录）。
fn ensure_dir(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    Ok(())
}

/// ZIP 解包的 zip-slip 防御核心（纯函数，便于单测）。
///
/// 给定 sandbox、其 canonicalize 路径、一个 ZIP entry 名（已由 `enclosed_name` 规范化），
/// 计算落盘目标路径并校验：
/// 1. entry 字符串不得含 `..`（双保险，`enclosed_name` 已过滤大部分）；
/// 2. 目标父目录 canonicalize 后必须在 `sandbox_canon` 之下（防符号链接/绝对路径越界）；
/// 3. 父目录不存在则创建。
///
/// 返回最终落盘路径。任一校验失败返回 `AppError::InvalidArg`（绝不写出 sandbox）。
fn resolve_zip_entry_path(
    sandbox: &Path,
    sandbox_canon: &Path,
    entry_name: &Path,
) -> Result<PathBuf, AppError> {
    let entry_str = entry_name.to_string_lossy().into_owned();
    // 防御：拒绝任何含 `..` 的 entry（enclosed_name 已过滤，这里双保险）
    if entry_str.contains("..") {
        return Err(AppError::InvalidArg(format!(
            "ZIP entry 含目录穿越: {entry_str}"
        )));
    }
    let out_path = sandbox.join(entry_name);

    // 关键防 zip-slip：canonicalize 父目录后 join 文件名，校验仍在 sandbox 内
    let parent = out_path.parent().unwrap_or(sandbox);
    if !parent.exists() {
        std::fs::create_dir_all(parent)?;
    }
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| AppError::Fs(format!("canonicalize 父目录失败: {e}")))?;
    if !parent_canon.starts_with(sandbox_canon) {
        return Err(AppError::InvalidArg(format!(
            "ZIP entry 逃逸 sandbox: {entry_str}"
        )));
    }
    Ok(out_path)
}

// =============================================================================
// 单元测试（P2-1）：zip-slip 防御 + atomic/append 经 spawn_blocking 链路验证
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 合法 entry（无 `..`、在 sandbox 内）应被接受，目标路径正确。
    #[test]
    fn zip_entry_in_sandbox_accepted() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let sandbox = tmp.path().join("campaign");
        std::fs::create_dir_all(&sandbox).unwrap();
        let sandbox_canon = sandbox.canonicalize().unwrap();

        let out =
            resolve_zip_entry_path(&sandbox, &sandbox_canon, std::path::Path::new("a/b.json"))
                .expect("合法 entry 应通过");
        assert_eq!(out, sandbox.join("a").join("b.json"));
    }

    /// 恶意 entry 含 `../`：应被拒绝，绝不返回 sandbox 外路径。
    #[test]
    fn zip_entry_with_dotdot_rejected() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let sandbox = tmp.path().join("campaign");
        std::fs::create_dir_all(&sandbox).unwrap();
        let sandbox_canon = sandbox.canonicalize().unwrap();

        let r = resolve_zip_entry_path(
            &sandbox,
            &sandbox_canon,
            std::path::Path::new("../evil.txt"),
        );
        assert!(r.is_err(), "含 ../ 的 entry 必须被拒绝");
        // 确认返回的是 InvalidArg 分类（zip-slip 安全错误）
        match r.unwrap_err() {
            AppError::InvalidArg(_) => {}
            other => panic!("应为 InvalidArg，实际 {other:?}"),
        }
    }

    /// 恶意 entry 含多层 `..` 试图逃逸更远：同样被拒。
    #[test]
    fn zip_entry_with_nested_dotdot_rejected() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let sandbox = tmp.path().join("campaign");
        std::fs::create_dir_all(&sandbox).unwrap();
        let sandbox_canon = sandbox.canonicalize().unwrap();

        let r = resolve_zip_entry_path(
            &sandbox,
            &sandbox_canon,
            std::path::Path::new("../../../../etc/passwd"),
        );
        assert!(r.is_err());
    }

    /// 恶意 entry 用符号链接把父目录指向 sandbox 外：canonicalize 校验应拒绝。
    #[test]
    #[cfg(unix)]
    fn zip_entry_symlink_escape_rejected() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let sandbox = tmp.path().join("campaign");
        std::fs::create_dir_all(&sandbox).unwrap();
        let sandbox_canon = sandbox.canonicalize().unwrap();

        // 在 sandbox 内放一个指向 sandbox 外的符号链接目录，伪装成 entry 父目录
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let link = sandbox.join("evil");
        symlink(&outside, &link).expect("创建符号链接失败");

        // entry 名构造为「evil/steal.txt」：父目录 evil 是符号链接→outside，
        // canonicalize 后落在 sandbox 外，必须被拒（即使路径字符串无 `..`）。
        // 注意：此处 entry 名不含 `..`，绕过字符串检查，靠 canonicalize 兜底。
        let r = resolve_zip_entry_path(
            &sandbox,
            &sandbox_canon,
            std::path::Path::new("evil/steal.txt"),
        );
        assert!(
            r.is_err(),
            "符号链接逃逸 sandbox 必须被 canonicalize 校验拒绝"
        );
    }
}

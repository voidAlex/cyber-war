//! 路径解析（用 `tauri::Manager::path` 解析 `app_data_dir`）
//!
//! 存储根布局（对应重写计划项目结构）：
//! ```text
//! <app_data_dir>/                      # OS 标准应用数据目录
//! ├── config/                          # 应用配置根（去口令后新增）
//! │   ├── llm-config.json              # LLM 配置（provider/endpoint/model，非密钥字段明文）
//! │   └── api-key.txt                  # apiKey 降级明文（仅 keyring 不可用时）
//! └── saves/                           # 所有存档的根目录
//!     └── <saveId>/                    # 单个存档目录
//!         ├── manifest.json            # 存档清单（scenarioId/seed/创建时间…）
//!         ├── world-state.json         # 当前世界状态（唯一真相源）
//!         ├── snapshot.json            # 快照（检查点）
//!         ├── event-log.jsonl          # 事件日志（真追加）
//!         ├── diagnostics.log          # 诊断日志（只写 status code）
//!         ├── factions/<id>.json       # 各阵营文件
//!         └── campaign/                # 已解包的战役包内容
//! ```
//!
//! 注意：`app_data_dir` 由 Tauri 注入的 `AppHandle` 提供，
//! command 层负责把 `AppHandle` 传入；本模块不缓存路径（每次按需解析）。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::AppError;

/// 单个存档内的标准文件名常量（避免到处写魔法字符串）
pub mod files {
    pub const MANIFEST: &str = "manifest.json";
    pub const WORLD_STATE: &str = "world-state.json";
    pub const SNAPSHOT: &str = "snapshot.json";
    pub const EVENT_LOG: &str = "event-log.jsonl";
    pub const DIAGNOSTICS: &str = "diagnostics.log";
    /// 战役包解包子目录名
    pub const CAMPAIGN_SUBDIR: &str = "campaign";
    /// 阵营文件子目录名
    pub const FACTIONS_SUBDIR: &str = "factions";
}

/// 应用配置根下的标准文件名常量（去口令改造：apiKey 经 OS 凭证库 + 降级明文）。
///
/// - `LLM_CONFIG`：LLM 非密钥配置（provider/endpoint/model），原子写明文 JSON。
/// - `API_KEY_PLAINTEXT`：apiKey 降级明文（仅 keyring 不可用时落盘）。
pub mod config_files {
    /// LLM 配置文件名（provider/endpoint/model，明文 JSON）
    pub const LLM_CONFIG: &str = "llm-config.json";
    /// apiKey 降级明文文件名（仅 keyring 失败时使用）
    pub const API_KEY_PLAINTEXT: &str = "api-key.txt";
}

/// 解析 saves 根目录：`<app_data_dir>/saves`。
///
/// 若该目录不存在会被 setup hook 创建；本函数仅负责路径解析，不创建目录。
pub fn resolve_saves_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Fs(format!("解析 app_data_dir 失败: {e}")))?;
    Ok(data_dir.join("saves"))
}

/// 解析应用配置根目录：`<app_data_dir>/config`。
///
/// 用于存放 LLM 配置（`llm-config.json`，明文非密钥字段）与 apiKey 降级明文
/// （`api-key.txt`，仅 keyring 不可用时落盘）。
///
/// 若该目录不存在会被 setup hook 创建；本函数仅负责路径解析，不创建目录。
pub fn resolve_config_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Fs(format!("解析 app_data_dir 失败: {e}")))?;
    Ok(data_dir.join("config"))
}

/// 单个存档目录的便捷句柄（封装 saveId 与各标准文件路径解析）。
#[derive(Debug, Clone)]
pub struct SaveDir {
    /// 完整存档目录路径 `<saves_root>/<saveId>`
    pub dir: PathBuf,
}

impl SaveDir {
    /// 按 saveId 构造（不校验目录是否存在）。
    pub fn new(saves_root: &std::path::Path, save_id: &str) -> Result<Self, AppError> {
        // saveId 仅允许安全字符（防目录穿越：禁止 `..` / 路径分隔符 / 空串）
        validate_save_id(save_id)?;
        Ok(Self {
            dir: saves_root.join(save_id),
        })
    }

    /// manifest.json 路径
    pub fn manifest(&self) -> PathBuf {
        self.dir.join(files::MANIFEST)
    }
    /// world-state.json 路径
    pub fn world_state(&self) -> PathBuf {
        self.dir.join(files::WORLD_STATE)
    }
    /// snapshot.json 路径
    pub fn snapshot(&self) -> PathBuf {
        self.dir.join(files::SNAPSHOT)
    }
    /// event-log.jsonl 路径
    pub fn event_log(&self) -> PathBuf {
        self.dir.join(files::EVENT_LOG)
    }
    /// diagnostics.log 路径
    pub fn diagnostics(&self) -> PathBuf {
        self.dir.join(files::DIAGNOSTICS)
    }
    /// 战役包解包子目录路径
    pub fn campaign_dir(&self) -> PathBuf {
        self.dir.join(files::CAMPAIGN_SUBDIR)
    }
    /// 阵营文件子目录路径
    pub fn factions_dir(&self) -> PathBuf {
        self.dir.join(files::FACTIONS_SUBDIR)
    }
    /// 指定阵营文件路径：`factions/<faction_id>.json`
    pub fn faction_file(&self, faction_id: &str) -> Result<PathBuf, AppError> {
        validate_filename(faction_id, "faction_id")?;
        Ok(self.factions_dir().join(format!("{faction_id}.json")))
    }
}

/// 解析单个存档目录（`saves_root` + `saveId` → `SaveDir`）。
pub fn resolve_save_dir(
    saves_root: &std::path::Path,
    save_id: &str,
) -> Result<SaveDir, AppError> {
    SaveDir::new(saves_root, save_id)
}

/// 校验 saveId：非空、不含路径分隔符、不含 `..`，仅允许字母数字及 `-_.`。
fn validate_save_id(save_id: &str) -> Result<(), AppError> {
    validate_filename(save_id, "saveId")
}

/// 通用文件名安全校验（防目录穿越）。
fn validate_filename(name: &str, label: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidArg(format!("{label} 不能为空")));
    }
    if name == ".." || name == "." || name.contains('/') || name.contains('\\') {
        return Err(AppError::InvalidArg(format!("{label} 含非法路径字符: {name}")));
    }
    if name.contains('\0') {
        return Err(AppError::InvalidArg(format!("{label} 含 NUL 字符")));
    }
    Ok(())
}

//! 统一错误类型 `AppError`（赛博战争模拟器 Rust 后端）
//!
//! 设计目的：对应审计教训「错误分类全错」——Rust 侧按 reqwest
//! `is_connect()/is_timeout()/status()` 精确分四类，前端不再猜。
//!
//! 安全约束：
//! - 错误信息绝不包含 API key、绝不包含请求 payload（仅写 HTTP status code 或类别）。
//! - `Display`/`Debug` 输出同样遵循此约束（便于 diagnostics 写入）。

use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;

/// LLM 错误四分类（对应 AGENTS.md 错误四分类红线）
///
/// - `Network`：连接级错误（DNS 解析失败、连接被拒、TLS 握手失败等）
/// - `ApiKey`：HTTP 401/403（鉴权失败）
/// - `LlmError`：其余 4xx/5xx（请求体错误、模型内部错误、限流等）
/// - `Timeout`：请求超时
///
/// 序列化为字符串（snake-case）便于前端用 `error.kind === 'network'` 判别。
/// 同时实现 Deserialize：`LlmStreamEvent::Error` 需从 IPC 往返解析。
/// 注意：Serialize 为手写 impl（按字符串序列化），故此处 derive 仅含 Deserialize。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum LlmErrorKind {
    Network,
    ApiKey,
    LlmError,
    Timeout,
}

// 自定义 Serialize（按字符串序列化，而非默认的单元变体枚举标签）。
// Deserialize 走 derive 默认实现（按变体名匹配）——前端若需用字符串反序列化，
// 应在 TS 侧用 snake-case 映射，或后续改用 #[serde(remote)] 自定义。
impl Serialize for LlmErrorKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl LlmErrorKind {
    /// 返回稳定的字符串标识（前端契约，不可随意改名）
    pub const fn as_str(self) -> &'static str {
        match self {
            LlmErrorKind::Network => "network",
            LlmErrorKind::ApiKey => "api_key",
            LlmErrorKind::LlmError => "llm_error",
            LlmErrorKind::Timeout => "timeout",
        }
    }
}

/// 应用统一错误枚举
///
/// 实现了 `serde::Serialize`：可被 Tauri command 直接返回给前端。
/// `From<std::io::Error>` / `From<serde_json::Error>` 等转换方便用 `?` 传播。
#[derive(Debug, Error, Serialize)]
#[serde(tag = "type", content = "message")]
pub enum AppError {
    /// 文件系统错误（读写存档、event-log、snapshot 等）
    #[error("文件系统错误: {0}")]
    #[serde(rename = "fs")]
    Fs(String),

    /// LLM 转发错误（带四分类 kind）
    #[error("LLM 错误({kind:?}): {message}")]
    #[serde(rename = "llm")]
    Llm {
        /// 错误类别（前端用于决定降级策略）
        kind: LlmErrorKind,
        /// 仅含 status code / 类别描述，绝不包含 key/payload
        message: String,
    },

    /// 加密错误（KDF 派生失败、AEAD 解密失败、密文格式损坏等）
    #[error("加密错误: {0}")]
    #[serde(rename = "crypto")]
    Crypto(String),

    /// 参数校验错误（路径不合法、provider 未知、JSON 结构不符等）
    #[error("无效参数: {0}")]
    #[serde(rename = "invalid_arg")]
    InvalidArg(String),
}

// === 便捷转换：让 `?` 自动把常见底层错误包成 AppError ===

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::Fs(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    /// JSON 序列化/反序列化失败归为参数错误（结构不符）
    fn from(err: serde_json::Error) -> Self {
        AppError::InvalidArg(format!("JSON 错误: {err}"))
    }
}

impl From<zip::result::ZipError> for AppError {
    /// ZIP 处理失败归为文件系统错误
    fn from(err: zip::result::ZipError) -> Self {
        AppError::Fs(format!("ZIP 错误: {err}"))
    }
}

/// 便于 command 内构造 LLM 错误
#[allow(dead_code)]
impl AppError {
    pub fn llm(kind: LlmErrorKind, message: impl Into<String>) -> Self {
        AppError::Llm {
            kind,
            message: message.into(),
        }
    }
}

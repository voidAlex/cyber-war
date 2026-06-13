//! Provider 路由（根据 provider 标识决定 base_url、鉴权头、请求体格式）
//!
//! 支持：
//! - `deepseek`：OpenAI 兼容，base_url `https://api.deepseek.com`，`Authorization: Bearer <key>`
//! - `openai`：标准 OpenAI，`Authorization: Bearer <key>`
//! - `custom`：用户自定义（走 Bearer），endpoint 由前端指定
//! - `anthropic`：`x-api-key` 头 + messages 格式，endpoint `https://api.anthropic.com`
//!
//! 重写计划「DeepSeek…对 Rust 后端的影响」章节明确：DeepSeek 走 OpenAI 兼容分支。

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 支持的 provider 标识
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Deepseek,
    Openai,
    Anthropic,
    Custom,
}

impl ProviderKind {
    /// 从字符串解析 provider（前端传入字符串）
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s.to_ascii_lowercase().as_str() {
            "deepseek" => Ok(Self::Deepseek),
            "openai" => Ok(Self::Openai),
            "anthropic" => Ok(Self::Anthropic),
            "custom" => Ok(Self::Custom),
            other => Err(AppError::InvalidArg(format!(
                "未知 provider: {other}（支持: deepseek/openai/anthropic/custom）"
            ))),
        }
    }

    /// 该 provider 是否允许自定义 endpoint（custom 允许任意白名单 endpoint）
    pub fn allows_custom_endpoint(self) -> bool {
        matches!(self, Self::Custom)
    }
}

/// 解析后的目标 endpoint（url 字符串形式）
pub fn resolve_provider(
    provider: ProviderKind,
    endpoint: &str,
) -> Result<String, AppError> {
    let url = match provider {
        // DeepSeek/OpenAI/Custom：endpoint 由前端给出（已在 gateway 层拼好完整 chat/completions 路径）
        ProviderKind::Deepseek | ProviderKind::Openai | ProviderKind::Custom => {
            if endpoint.is_empty() {
                return Err(AppError::InvalidArg(format!(
                    "{provider:?} provider 缺少 endpoint"
                )));
            }
            endpoint.to_string()
        }
        // Anthropic：使用 messages 端点（前端亦可直接传完整 URL，这里兼容两种）
        ProviderKind::Anthropic => {
            if endpoint.is_empty() {
                "https://api.anthropic.com/v1/messages".to_string()
            } else {
                endpoint.to_string()
            }
        }
    };
    Ok(url)
}

/// 根据 provider 构造请求头（鉴权头 + Content-Type）。
///
/// 安全：返回的 reqwest::headermap 仅在调用栈内存在，随请求发出后即 Drop。
pub fn build_headers(
    provider: ProviderKind,
    api_key: &str,
) -> Result<reqwest::header::HeaderMap, AppError> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );

    match provider {
        ProviderKind::Deepseek | ProviderKind::Openai | ProviderKind::Custom => {
            // OpenAI 兼容：Authorization: Bearer <key>
            let val = HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
                AppError::InvalidArg("API key 含非法 header 字符".into())
            })?;
            headers.insert(HeaderName::from_static("authorization"), val);
        }
        ProviderKind::Anthropic => {
            // Anthropic：x-api-key + anthropic-version
            let key_val = HeaderValue::from_str(api_key).map_err(|_| {
                AppError::InvalidArg("API key 含非法 header 字符".into())
            })?;
            headers.insert(HeaderName::from_static("x-api-key"), key_val);
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        }
    }

    Ok(headers)
}

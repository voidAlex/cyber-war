//! 重试与降级策略（单请求 30s 超时，退避 1s/2s/4s 最多 3 次）
//!
//! 对应重写计划「LLM 错误分类全错」+ AGENTS.md 错误处理：
//! - 单请求超时 30s（reqwest client 级超时）
//! - 失败后按 1s/2s/4s 指数退避重试，最多 3 次
//! - 3 次均失败返回 `LlmFinalResult { degraded: true }`，由前端切规则引擎兜底
//!
//! 降级语义：degraded=true 表示「LLM 不可用」，但**绝不伪造数据**
//! （对应审计教训「解析失败伪造 unit-1/C3」——伪造发生在前端降级路径，
//! Rust 侧只如实返回 degraded 标志）。

use std::time::Duration;

use tauri::ipc::Channel;

use crate::error::{AppError, LlmErrorKind};
use crate::llm::stream::{stream_forward_once, LlmFinalResult, LlmStreamEvent};
use crate::llm::ForwardRequest;

/// 重试配置（AGENTS.md 红线参数：30s 超时 / 1s/2s/4s 退避 / 最多 3 次）。
#[derive(Debug, Clone, Copy)]
pub struct RetryConfig {
    /// 单请求超时
    pub request_timeout: Duration,
    /// 退避间隔序列（第 n 次重试前等待）
    pub backoffs: [Duration; 3],
    /// 最大尝试次数（含首次）
    pub max_attempts: u32,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(30),
            backoffs: [
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
            ],
            max_attempts: 3,
        }
    }
}

/// 创建带 30s 超时的 reqwest 客户端。
pub fn build_reqwest_client(cfg: &RetryConfig) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(cfg.request_timeout)
        .build()
        .map_err(|e| AppError::llm(LlmErrorKind::Network, format!("构建 HTTP 客户端失败: {e}")))
}

/// 带重试的流式转发。
///
/// - 每次 attempt 调用 [`stream_forward_once`]。
/// - 成功立即返回结果。
/// - 失败：若已达到 `max_attempts`，返回 `degraded:true` 的 `LlmFinalResult`；
///   否则按 backoffs 退避后重试。
/// - 每次失败通过 `on_event` emit `Error` 事件，便于前端展示重试进度。
pub async fn stream_forward_with_retry(
    request: &ForwardRequest,
    on_event: &Channel<LlmStreamEvent>,
    cfg: &RetryConfig,
) -> Result<LlmFinalResult, AppError> {
    let client = build_reqwest_client(cfg)?;
    let mut attempt: u32 = 0;

    loop {
        attempt += 1;
        match stream_forward_once(&client, request, on_event).await {
            Ok(result) => return Ok(result),
            Err(err) => {
                // 记录失败（仅 emit 类别 + message，绝不含 key/payload）
                let kind = llm_kind_of(&err);
                let message = llm_message_of(&err);
                let _ = on_event.send(LlmStreamEvent::Error { kind, message });

                if attempt >= cfg.max_attempts {
                    // 3 次均失败：返回降级结果（绝不伪造，前端切规则引擎）
                    let _ = on_event.send(LlmStreamEvent::Done);
                    return Ok(LlmFinalResult {
                        degraded: true,
                        prompt_cache_hit_tokens: None,
                        prompt_cache_miss_tokens: None,
                        input_tokens: None,
                        output_tokens: None,
                    });
                }

                // 退避后重试（backoffs 索引 = attempt-1）
                let backoff = cfg.backoffs[(attempt - 1) as usize];
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

/// 从 AppError 提取 LLM 错误类别（仅 Llm 变体有 kind，其余归 Network）。
fn llm_kind_of(err: &AppError) -> LlmErrorKind {
    match err {
        AppError::Llm { kind, .. } => *kind,
        _ => LlmErrorKind::Network,
    }
}

/// 从 AppError 提取可展示消息（脱敏：仅 Llm 变体透传类别描述）。
fn llm_message_of(err: &AppError) -> String {
    match err {
        AppError::Llm { message, .. } => message.clone(),
        other => format!("{other}"),
    }
}

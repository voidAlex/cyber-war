//! 真流式转发（reqwest `.bytes_stream()`，绝不伪造、绝不 padding）
//!
//! 对应审计教训「伪流式 + padding 凑 11s」——旧网页版是「事后切片伪造流式」，
//! 这里用 reqwest 的 `bytes_stream()` 真流式：
//!
//! - 每收到一段 `data:` SSE 事件，立即通过 Tauri `Channel` emit `Delta{text}`
//! - **绝不攒完整响应**、**绝不 sleep/padding**
//! - 末帧（含 `usage`）解析出 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 透传
//!
//! 错误四分类：按 reqwest `is_connect()/is_timeout()/status()` 精确分类。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{AppError, LlmErrorKind};
use crate::llm::router::build_headers;
use crate::llm::ForwardRequest;

/// 发往前端的流式事件（通过 Tauri `Channel<LlmStreamEvent>` 传输）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmStreamEvent {
    /// 增量文本（每段 `data:` 立即发出）
    Delta {
        /// 本段增量文本
        text: String,
    },
    /// 末帧 usage（透传 DeepSeek 缓存命中统计）
    Usage {
        /// 缓存命中 token 数
        prompt_cache_hit_tokens: Option<u64>,
        /// 缓存未命中 token 数
        prompt_cache_miss_tokens: Option<u64>,
        /// 输入 token 数（通用）
        input_tokens: Option<u64>,
        /// 输出 token 数（通用）
        output_tokens: Option<u64>,
    },
    /// 单次请求结束（正常或降级）
    Done,
    /// 错误（带四分类 kind）
    Error {
        /// 错误类别
        kind: LlmErrorKind,
        /// 仅含 status code / 类别描述
        message: String,
    },
}

/// 一次完整转发的最终结果（在流结束后返回给前端 invoke 调用方）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmFinalResult {
    /// 是否降级（3 次重试均失败时为 true，前端切规则引擎兜底）
    pub degraded: bool,
    /// 末帧 usage（若 provider 返回）
    pub prompt_cache_hit_tokens: Option<u64>,
    pub prompt_cache_miss_tokens: Option<u64>,
    /// 输入 token 数（通用）
    pub input_tokens: Option<u64>,
    /// 输出 token 数（通用）
    pub output_tokens: Option<u64>,
}

/// 执行一次流式转发（不含重试；重试由 [`crate::llm::retry`] 包装）。
///
/// `on_event` 是前端创建的 Tauri Channel，每段增量文本立即 emit。
/// 返回 `LlmFinalResult`（含 usage）。
pub async fn stream_forward_once(
    reqwest_client: &reqwest::Client,
    request: &ForwardRequest,
    on_event: &Channel<LlmStreamEvent>,
) -> Result<LlmFinalResult, AppError> {
    // 构造请求头（含鉴权，随请求发出后 Drop）
    let headers = build_headers(request.provider, &request.api_key)?;

    // 构造 POST 请求（payload 透传，不解析游戏语义）
    let http_req = reqwest_client
        .post(&request.endpoint)
        .headers(headers)
        .json(&request.payload);

    // 发送请求：连接/超时错误按 reqwest 标志精确分类
    let response = http_req.send().await.map_err(|err| {
        classify_reqwest_error(&err)
    })?;

    // HTTP 状态码校验：401/403 → ApiKey，其余 4xx/5xx → LlmError
    let status = response.status();
    if !status.is_success() {
        return Err(classify_status(status));
    }

    // 真流式：bytes_stream 逐段读取
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut last_usage: Option<serde_json::Value> = None;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|err| classify_reqwest_error(&err))?;
        // chunk 是原始字节，按 SSE 协议（`data: ...\n\n`）逐行解析
        let text = String::from_utf8_lossy(&chunk);
        for line in text.lines() {
            let line = line.trim();
            // 跳过空行与注释行
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            // 解析 `data: ` 前缀
            let payload_str = if let Some(rest) = line.strip_prefix("data: ") {
                rest
            } else if let Some(rest) = line.strip_prefix("data:") {
                rest
            } else {
                // 非 data 行（event/id 等忽略）
                continue;
            };

            // [DONE] 标记：SSE 结束
            if payload_str.trim() == "[DONE]" {
                continue;
            }

            // 尝试解析 JSON：成功则可能是带 usage 的帧或带 delta 的帧
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload_str) {
                // 提取 usage（若有）——末帧会带
                if let Some(usage) = json.get("usage") {
                    last_usage = Some(usage.clone());
                }
                // 提取增量文本（OpenAI 兼容格式 choices[].delta.content）
                let delta_text = extract_delta_text(&json, request.provider);
                if !delta_text.is_empty() {
                    // 立即 emit，绝不攒批
                    let _ = on_event.send(LlmStreamEvent::Delta { text: delta_text });
                }
            } else {
                // 非 JSON 的 data 行（极少见）：作为原始文本透传
                if !payload_str.is_empty() {
                    let _ = on_event.send(LlmStreamEvent::Delta {
                        text: payload_str.to_string(),
                    });
                }
            }
        }
    }

    // 流结束：透传 usage（若有）
    let mut result = LlmFinalResult {
        degraded: false,
        prompt_cache_hit_tokens: None,
        prompt_cache_miss_tokens: None,
        input_tokens: None,
        output_tokens: None,
    };
    if let Some(usage) = last_usage {
        // DeepSeek/OpenAI 缓存字段
        result.prompt_cache_hit_tokens = usage
            .get("prompt_cache_hit_tokens")
            .and_then(|v| v.as_u64());
        result.prompt_cache_miss_tokens = usage
            .get("prompt_cache_miss_tokens")
            .and_then(|v| v.as_u64());
        // 通用 token 字段（OpenAI prompt_tokens / Anthropic input_tokens）
        result.input_tokens = usage
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| usage.get("input_tokens").and_then(|v| v.as_u64()));
        result.output_tokens = usage
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .or_else(|| usage.get("output_tokens").and_then(|v| v.as_u64()));

        let _ = on_event.send(LlmStreamEvent::Usage {
            prompt_cache_hit_tokens: result.prompt_cache_hit_tokens,
            prompt_cache_miss_tokens: result.prompt_cache_miss_tokens,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
        });
    }

    let _ = on_event.send(LlmStreamEvent::Done);

    Ok(result)
}

/// 从一帧 JSON 提取增量文本（适配 OpenAI 兼容与 Anthropic 两种格式）。
fn extract_delta_text(json: &serde_json::Value, provider: crate::llm::ProviderKind) -> String {
    use crate::llm::ProviderKind;
    match provider {
        ProviderKind::Anthropic => {
            // Anthropic: events 里的 content_block_delta.delta.text
            json.pointer("/delta/text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        ProviderKind::Deepseek | ProviderKind::Openai | ProviderKind::Custom => {
            // OpenAI 兼容: choices[].delta.content
            json.pointer("/choices/0/delta/content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
    }
}

/// 按 reqwest 错误标志精确分类（对应审计教训「错误分类全错」）。
fn classify_reqwest_error(err: &reqwest::Error) -> AppError {
    if err.is_timeout() {
        AppError::llm(LlmErrorKind::Timeout, format!("请求超时（status 仅记类别）"))
    } else if err.is_connect() || err.is_request() {
        AppError::llm(LlmErrorKind::Network, "连接级错误".to_string())
    } else {
        AppError::llm(LlmErrorKind::Network, format!("网络错误（{err}）"))
    }
}

/// 按 HTTP 状态码分类（401/403 → ApiKey，其余非 2xx → LlmError）。
fn classify_status(status: reqwest::StatusCode) -> AppError {
    let code = status.as_u16();
    match code {
        401 | 403 => AppError::llm(
            LlmErrorKind::ApiKey,
            format!("鉴权失败（HTTP {code}）"),
        ),
        _ => AppError::llm(
            LlmErrorKind::LlmError,
            format!("LLM 返回错误（HTTP {code}）"),
        ),
    }
}

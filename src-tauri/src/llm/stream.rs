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
//!
//! # 跨 chunk 缓冲（P1-1 修复）
//!
//! SSE 帧按 `\n` 分行，但 reqwest 的 `bytes_stream()` 每个 chunk 的边界与
//! SSE 行边界**无关**：一段 `data: {...}\n\n` 可能被网络 MTU 切成两个 chunk，
//! 第二段不以 `data:` 开头。若每 chunk 直接 `text.lines()` 逐行解析（无缓冲），
//! 被切的行会被当成「非 data 行」走原始文本 fallback 透传，导致该帧 JSON 解析
//! 失败、usage/delta 丢失。
//!
//! 修复：维护跨 chunk 的 `pending: String`。每 chunk 追加后按 `\n` split，
//! **末尾不完整行留在 pending** 下轮拼接；遇 `[DONE]` 或流结束 flush pending。
//! 核心逻辑抽成纯函数 [`parse_sse_chunk`] 便于单测。

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{AppError, LlmErrorKind};
use crate::llm::router::build_headers;
use crate::llm::ForwardRequest;

/// 一条解析后的 SSE 数据行（仅 `data:` 前缀行；event/id/注释等被忽略）。
///
/// 由纯函数 [`parse_sse_chunk`] 产出，供 [`stream_forward_once`] 逐行处理。
/// `[DONE]` 标记单独表示为 [`SseLine::Done`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseLine {
    /// 一条 `data:` 行的载荷（已剥除 `data:` / `data: ` 前缀，未做 JSON 解析）
    Data(String),
    /// `[DONE]` 结束标记
    Done,
}

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

/// 纯函数：把一段 chunk 文本喂入跨 chunk 缓冲 `pending`，产出本 chunk 内**完整**的 SSE 数据行。
///
/// P1-1 修复的核心：网络 chunk 边界与 SSE 行边界无关，一段 `data: {...}` 可能被
/// MTU 切成两段。本函数保证：
/// - 先把 `text` 追加到 `pending`；
/// - 按 `\n` 切分，**除最后一段外**都是完整行，逐行解析为 [`SseLine`]；
/// - **最后一段若无换行结尾（被截断的半行）留在 `pending`**，等下个 chunk 拼接；
/// - 跳过空行与 `:` 注释行；`event:`/`id:` 等非 data 行忽略。
///
/// 返回本 chunk 解析出的完整行（可能为空，若整 chunk 都是一段半行）。
/// 流结束时调用方应自行 flush：见 [`parse_sse_flush`]。
fn parse_sse_chunk(pending: &mut String, text: &str) -> Vec<SseLine> {
    pending.push_str(text);

    // 没有 `\n`：整段都是半行，留在 pending，本 chunk 无完整行产出
    let mut lines = Vec::new();
    loop {
        match pending.find('\n') {
            // 找到换行：取出一行（含末尾 \n 的前缀），余下留 pending
            Some(idx) => {
                let line: String = pending.drain(..=idx).collect();
                if let Some(parsed) = parse_one_sse_line(&line) {
                    lines.push(parsed);
                }
            }
            // 无换行：剩余是不完整半行，等下个 chunk
            None => break,
        }
    }
    lines
}

/// 流结束时的 flush：把 `pending` 里残留的最后一段（无 `\n` 结尾）也当一行解析。
///
/// 真实 SSE 最后一帧通常以 `\n\n` 结尾，pending 此时为空；但个别 provider
/// 末帧可能不带尾随换行，flush 保证不丢最后一行。
fn parse_sse_flush(pending: &mut String) -> Vec<SseLine> {
    if pending.is_empty() {
        return Vec::new();
    }
    let last = std::mem::take(pending);
    match parse_one_sse_line(&last) {
        Some(parsed) => vec![parsed],
        None => Vec::new(),
    }
}

/// 解析**单条**已含（或不含）换行符的 SSE 行为 [`SseLine`]。
/// 返回 `None` 表示该行应跳过（空行 / 注释 / event / id 等非 data 行）。
fn parse_one_sse_line(raw: &str) -> Option<SseLine> {
    let line = raw.trim();
    if line.is_empty() || line.starts_with(':') {
        return None;
    }
    let payload_str = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:"))?;
    if payload_str.trim() == "[DONE]" {
        return Some(SseLine::Done);
    }
    Some(SseLine::Data(payload_str.to_string()))
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
    // 跨 chunk 缓冲（P1-1）：网络 chunk 边界与 SSE 行边界无关，
    // 一段 `data: {...}` 被切成两段时，半行留在 pending 等下个 chunk 拼接。
    let mut pending: String = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|err| classify_reqwest_error(&err))?;
        // chunk 是原始字节，喂入跨 chunk 缓冲，按 SSE 协议逐行解析
        let text = String::from_utf8_lossy(&chunk);
        let lines = parse_sse_chunk(&mut pending, &text);
        for line in lines {
            match line {
                SseLine::Done => {
                    // [DONE]：SSE 结束标记，不再处理后续（但仍 flush 之前缓冲）
                }
                SseLine::Data(payload_str) => {
                    // 尝试解析 JSON：成功则可能是带 usage 的帧或带 delta 的帧
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload_str) {
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
                                text: payload_str,
                            });
                        }
                    }
                }
            }
        }
    }

    // 流结束：flush pending 残留的最后一段（个别 provider 末帧不带尾随换行）
    for line in parse_sse_flush(&mut pending) {
        if let SseLine::Data(payload_str) = line {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload_str) {
                if let Some(usage) = json.get("usage") {
                    last_usage = Some(usage.clone());
                }
                let delta_text = extract_delta_text(&json, request.provider);
                if !delta_text.is_empty() {
                    let _ = on_event.send(LlmStreamEvent::Delta { text: delta_text });
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

// =============================================================================
// 单元测试：SSE 跨 chunk 缓冲（P1-1）
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 一段 `data: {...}` 行被 MTU 切成两段，验证能正确合并解析。
    /// 第一段 `data: {"choices` 不含换行（半行留在 pending）；
    /// 第二段 `":[{"delta":{"content":"hi"}}]}\n\n` 拼接后才能 JSON 解析。
    #[test]
    fn split_data_line_across_chunks_is_merged() {
        let mut pending = String::new();

        // 第一段：半行，无换行 → 无完整行产出，半行留 pending
        let chunk1 = "data: {\"choices\"";
        let lines1 = parse_sse_chunk(&mut pending, chunk1);
        assert!(
            lines1.is_empty(),
            "半行（无换行）不应产出完整行，实际：{lines1:?}"
        );
        assert_eq!(pending, chunk1, "半行应留在 pending 等拼接");

        // 第二段：补全后含 \n\n → 应产出 1 条完整 data 行
        let chunk2 = ":[{\"delta\":{\"content\":\"hi\"}}]}\n\n";
        let lines2 = parse_sse_chunk(&mut pending, chunk2);
        assert_eq!(pending, "", "完整行解析后 pending 应清空");
        assert_eq!(lines2.len(), 1, "应产出 1 条 data 行");
        match &lines2[0] {
            SseLine::Data(s) => {
                // 该载荷必须可解析为合法 JSON（验证没被当原始文本 fallback 透传）
                let v: serde_json::Value =
                    serde_json::from_str(s).expect("合并后的载荷应为合法 JSON");
                assert_eq!(v["choices"][0]["delta"]["content"], "hi");
            }
            other => panic!("应为 Data 变体，实际 {other:?}"),
        }
    }

    /// 多帧跨 chunk 混合：一个 chunk 内含多行 + 末尾半行 + [DONE] 标记。
    #[test]
    fn multiple_frames_with_trailing_partial_and_done() {
        let mut pending = String::new();

        // chunk A：完整帧 + 半行
        let chunk_a = "data: {\"a\":1}\ndata: {\"b\":2}\ndata: {\"c\":";
        let a = parse_sse_chunk(&mut pending, chunk_a);
        assert_eq!(a.len(), 2, "前两行完整应各产 1 条");
        assert_eq!(pending, "data: {\"c\":", "末尾半行留 pending");

        // chunk B：补全上一行 + [DONE]
        let chunk_b = "3}\ndata: [DONE]\n\n";
        let b = parse_sse_chunk(&mut pending, chunk_b);
        assert_eq!(b.len(), 2, "应产出补全行 + Done");
        assert!(matches!(b[0], SseLine::Data(ref s) if s == "{\"c\":3}"));
        assert_eq!(b[1], SseLine::Done);
        assert!(pending.is_empty());
    }

    /// flush：流结束时 pending 残留的最后一行（无尾随换行）也应被解析。
    #[test]
    fn flush_emits_trailing_line_without_newline() {
        let mut pending = String::new();
        // provider 末帧不带 \n
        parse_sse_chunk(&mut pending, "data: {\"usage\":1}");
        assert!(!pending.is_empty());
        let flushed = parse_sse_flush(&mut pending);
        assert_eq!(flushed.len(), 1);
        assert!(matches!(flushed[0], SseLine::Data(ref s) if s == "{\"usage\":1}"));
        assert!(pending.is_empty());
    }

    /// 非法 / 半截 JSON 必须仍能保持缓冲正确性（不被错误地提前解析）。
    #[test]
    fn partial_json_split_mid_string_is_merged() {
        let mut pending = String::new();
        // 把 `data: {"x":"he` 与 `llo"}\n` 切开
        let l1 = parse_sse_chunk(&mut pending, "data: {\"x\":\"he");
        assert!(l1.is_empty());
        let l2 = parse_sse_chunk(&mut pending, "llo\"}\n");
        assert_eq!(l2.len(), 1);
        match &l2[0] {
            SseLine::Data(s) => {
                let v: serde_json::Value = serde_json::from_str(s).unwrap();
                assert_eq!(v["x"], "hello");
            }
            _ => panic!(),
        }
    }

    /// 注释行 / 空行 / event 行应被忽略，不污染缓冲。
    #[test]
    fn comments_and_event_lines_ignored() {
        let mut pending = String::new();
        let chunk = ": ping\n\nevent: token\ndata: {\"ok\":1}\n\n";
        let lines = parse_sse_chunk(&mut pending, chunk);
        assert_eq!(lines.len(), 1);
        assert!(matches!(&lines[0], SseLine::Data(s) if s == "{\"ok\":1}"));
    }

    /// `data:` 前缀无空格（`data:{...}`）也应正确解析。
    #[test]
    fn data_prefix_without_space() {
        let mut pending = String::new();
        let lines = parse_sse_chunk(&mut pending, "data:{\"k\":9}\n");
        assert_eq!(lines.len(), 1);
        assert!(matches!(&lines[0], SseLine::Data(s) if s == "{\"k\":9}"));
    }
}

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
///
/// 安全（P1-5 SSRF 重定向绕过防御）：
/// 显式设置 `.redirect(Policy::none())` 禁止跟随任何 3xx 重定向。
/// 原因：guard.rs 已在请求发出前校验目标 host 的 IP（拒绝私网/云元数据），
/// 但若放任 reqwest 默认 `Policy::default(10)`，攻击者可用一个白名单 host
/// 返回 3xx Location 指向 169.254.169.254 等内网/元数据端点——此时 reqwest
/// 会带着 `Authorization: Bearer <apiKey>`（或 `x-api-key`）自动跳过去，
/// 导致 SSRF + apiKey 泄露给恶意端点。关闭重定向后，3xx 一律以错误返回，
/// 由前端决定是否人工处理，绝不自动跟随。
pub fn build_reqwest_client(cfg: &RetryConfig) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(cfg.request_timeout)
        // 关键：禁止跟随重定向，杜绝 SSRF 重定向绕过（见函数文档）。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::llm(LlmErrorKind::Network, format!("构建 HTTP 客户端失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P1-5 回归测试：构建出的 client 必须禁止跟随重定向。
    ///
    /// 零依赖验证思路（不引入 mockito，避免扩大依赖范围）：
    /// - 启动两个本地 `TcpListener`（各自 `127.0.0.1:0` 随机端口）：
    ///   - server1 收到任何请求就回 `HTTP/1.1 302 Found\r\nLocation: <server2>\r\n\r\n`；
    ///   - server2 收到请求就在共享原子计数器 +1（模拟"内网元数据端点被命中 = 泄露"）。
    /// - 用 `build_reqwest_client` 发请求到 server1，断言：
    ///   1. 返回的 status 仍是 302（没有跟随到 server2）；
    ///   2. server2 的命中计数为 0（SSRF 未发生）。
    ///
    /// 回归保护：若有人误把 `.redirect(Policy::none())` 删掉，
    /// reqwest 会默认 `Policy::default(10)`，跟随到 server2，两条断言都会失败。
    #[tokio::test]
    async fn client_does_not_follow_redirects() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let leak_hits = Arc::new(AtomicUsize::new(0));

        // server2：模拟被重定向指向的"恶意内网端点"，命中即计数。
        let leak_hits_for_server = leak_hits.clone();
        let server2 = std::net::TcpListener::bind("127.0.0.1:0").expect("bind server2");
        let server2_addr = server2.local_addr().expect("server2 addr");
        server2.set_nonblocking(true).ok();
        let server2_target_url = format!("http://127.0.0.1:{}/", server2_addr.port());
        // 后台线程 accept server2 的连接（client 若跟随重定向会连这里）
        let server2_handle = std::thread::spawn(move || {
            for stream in server2.incoming() {
                if let Ok(mut s) = stream {
                    leak_hits_for_server.fetch_add(1, Ordering::SeqCst);
                    // 读掉请求（忽略），回 200
                    use std::io::{Read, Write};
                    let mut buf = [0u8; 256];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\nMETA-LEAK");
                }
            }
        });
        let _ = server2_handle; // 后台线程随进程退出，无需 join

        // server1：始终回 302 Location: <server2>，诱导 client 跟随。
        let server1 = std::net::TcpListener::bind("127.0.0.1:0").expect("bind server1");
        let server1_addr = server1.local_addr().expect("server1 addr");
        server1.set_nonblocking(true).ok();
        let location = format!(
            "HTTP/1.1 302 Found\r\nlocation: {}\r\ncontent-length: 0\r\n\r\n",
            server2_target_url
        );
        let server1_handle = std::thread::spawn(move || {
            for stream in server1.incoming() {
                if let Ok(mut s) = stream {
                    use std::io::{Read, Write};
                    let mut buf = [0u8; 256];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(location.as_bytes());
                }
            }
        });
        let _ = server1_handle;

        // 用 build_reqwest_client 构建被测 client
        let cfg = RetryConfig::default();
        let client = build_reqwest_client(&cfg).expect("client 构建成功");

        let start_url = format!("http://127.0.0.1:{}/v1/messages", server1_addr.port());
        let resp = client
            .post(&start_url)
            .body("{}")
            .send()
            .await
            .expect("请求应成功发出（即使 302，send 也不报错）");

        // 断言 1：status 仍是 302（client 没有跟随重定向）
        assert_eq!(
            resp.status().as_u16(),
            302,
            "client 禁止跟随重定向，应原样返回 302 而非跟随后的状态"
        );

        // 给可能的"跟随"一点时间窗口，确保若 client 真的跟随了，计数能反映出来。
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // 断言 2：server2（恶意内网端点）从未被访问（SSRF 未发生）
        assert_eq!(
            leak_hits.load(Ordering::SeqCst),
            0,
            "client 不应跟随重定向到第二个端点（SSRF 防御生效）"
        );
    }
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

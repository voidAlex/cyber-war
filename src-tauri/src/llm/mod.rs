//! LLM 转发模块（赛博战争模拟器 Rust 后端 — 爪牙之一）
//!
//! 职责硬约束：**不缓存 key、不懂 payload、不做游戏判定**。
//! 仅做：endpoint 安全校验 → reqwest 真流式转发 → usage 透传。
//!
//! 子模块：
//! - [`router`]：provider 路由（deepseek/openai/anthropic/custom）
//! - [`guard`]：host 白名单 + 私网/元数据 IP 拒绝（SSRF 防御）+ 生产强制 https
//! - [`stream`]：reqwest `.bytes_stream()` 真流式，每段 `data:` 立即 emit Delta
//! - [`retry`]：单请求 30s 超时，1s/2s/4s 退避最多 3 次，失败返回 degraded:true

pub mod guard;
pub mod retry;
pub mod router;
pub mod stream;

pub use retry::{stream_forward_with_retry, RetryConfig};
pub use router::{resolve_provider, ProviderKind};
pub use stream::{LlmFinalResult, LlmStreamEvent};

/// 一次 LLM 转发请求的输入参数（来自前端 invoke）。
///
/// 注意：`api_key` 仅作函数参数传递，绝不写文件/日志；
/// diagnostics 只写 status code，绝不写 key/payload。
#[derive(Debug, Clone)]
pub struct ForwardRequest {
    /// provider 标识（deepseek/openai/anthropic/custom）
    pub provider: ProviderKind,
    /// 目标 endpoint URL（已通过 guard 校验为白名单 host）
    pub endpoint: String,
    /// API key（即用即抛，不缓存）
    pub api_key: String,
    /// 请求体（透传，Rust 不解析其游戏语义）
    pub payload: serde_json::Value,
}

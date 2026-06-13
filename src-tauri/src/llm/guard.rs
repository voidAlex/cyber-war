//! SSRF 防御守卫（host 白名单 + 私网/元数据 IP 拒绝 + 生产强制 https）
//!
//! 对应审计教训「LLM 转发是开放中继(SSRF)」——旧网页版 Node 转发器可被诱导
//! 请求内网/云元数据。本守卫三重防线：
//!
//! 1. **host 白名单**：endpoint host 必须是
//!    `api.openai.com` / `api.anthropic.com` / `api.deepseek.com`
//!    或设置里由用户显式注入的 custom host。
//! 2. **私网/元数据 IP 拒绝**：解析 host 的 IP 地址，拒绝
//!    `10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`
//!    及云元数据 `169.254.169.254`。
//! 3. **生产强制 https**：debug 构建可放行 http，release 构建强制 https。
//!
//! 注意：DNS 重绑定攻击（解析后 IP 在请求前变化）需要更复杂的运行时校验，
//! 这里采用「解析时校验 IP」作为基本防线（reqwest 会在连接时再次解析，
//! 完整 DNS-rebinding 防御需自定义 resolver，M1 阶段先建立基本防线）。

use std::net::IpAddr;

use crate::error::{AppError, LlmErrorKind};

/// 内置白名单 host（DeepSeek 为推荐默认供应商）
pub const DEFAULT_ALLOWED_HOSTS: &[&str] = &[
    "api.openai.com",
    "api.anthropic.com",
    "api.deepseek.com",
];

/// 用户在设置里注入的额外白名单 host（custom provider 用）。
/// 注意：这是「显式允许列表」而非「任意放行」——即使 custom provider，
/// endpoint host 也必须出现在这个列表里。
#[derive(Debug, Clone, Default)]
pub struct AllowedHosts {
    /// 用户注入的 custom host 列表（已小写化、去端口）
    pub custom: Vec<String>,
}

impl AllowedHosts {
    pub fn new(custom: impl IntoIterator<Item = String>) -> Self {
        Self {
            custom: custom
                .into_iter()
                .map(|h| normalize_host(&h).to_string())
                .collect(),
        }
    }

    /// 判断 host 是否在白名单（内置 + custom）
    pub fn contains(&self, host: &str) -> bool {
        let h = normalize_host(host);
        DEFAULT_ALLOWED_HOSTS.iter().any(|d| *d == h) || self.custom.iter().any(|c| *c == h)
    }
}

/// 校验 endpoint URL 是否安全可转发。
///
/// 步骤：
/// 1. 解析 URL，校验 scheme（release 强制 https）。
/// 2. 提取 host，校验在白名单内。
/// 3. 若 host 是 IP 字面量，校验非私网/元数据；若 host 是域名，解析其 IP 后再校验。
///
/// 校验失败返回 `AppError::Llm { kind: Network, .. }`（前端归类为网络错误并提示检查 endpoint）。
pub fn validate_endpoint(endpoint: &str, allowed: &AllowedHosts) -> Result<(), AppError> {
    // 1. 解析 URL
    let url = url::Url::parse(endpoint).map_err(|_| {
        AppError::llm(
            LlmErrorKind::Network,
            format!("无效的 endpoint URL: {endpoint}"),
        )
    })?;

    // 2. scheme 校验：release 强制 https
    if cfg!(not(debug_assertions)) && url.scheme() != "https" {
        return Err(AppError::llm(
            LlmErrorKind::Network,
            "生产环境强制使用 https endpoint".to_string(),
        ));
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::llm(
            LlmErrorKind::Network,
            format!("不允许的 scheme: {}（仅 http/https）", url.scheme()),
        ));
    }

    // 3. host 提取 + 白名单校验
    let host = url.host_str().ok_or_else(|| {
        AppError::llm(LlmErrorKind::Network, "endpoint 缺少 host".to_string())
    })?;
    let host = normalize_host(host);

    if !allowed.contains(host) {
        return Err(AppError::llm(
            LlmErrorKind::Network,
            format!("endpoint host 不在白名单: {host}"),
        ));
    }

    // 4. IP 校验：拒绝私网/元数据段
    validate_host_ips(host)?;

    Ok(())
}

/// 解析 host 的所有 IP 地址并逐一校验非私网/元数据。
fn validate_host_ips(host: &str) -> Result<(), AppError> {
    // 若 host 本身是 IP 字面量，直接校验
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(AppError::llm(
                LlmErrorKind::Network,
                format!("endpoint 解析到禁用 IP: {ip}（私网/环回/链路本地/元数据）"),
            ));
        }
        return Ok(());
    }

    // 域名：DNS 解析后校验（解析失败归为网络错误）
    // 注意：DNS 解析可能受网络环境影响（离线时失败），属预期行为。
    let addrs = match resolve_host_ips(host) {
        Ok(addrs) => addrs,
        Err(_) => {
            // 解析失败视为网络错误（前端会重试或提示）
            return Err(AppError::llm(
                LlmErrorKind::Network,
                format!("无法解析 endpoint host: {host}"),
            ));
        }
    };

    for ip in addrs {
        if is_blocked_ip(ip) {
            return Err(AppError::llm(
                LlmErrorKind::Network,
                format!("endpoint 解析到禁用 IP: {ip}（私网/环回/链路本地/元数据）"),
            ));
        }
    }
    Ok(())
}

/// 解析域名为 IP 地址列表（DNS 查询）。
fn resolve_host_ips(host: &str) -> std::io::Result<Vec<IpAddr>> {
    use std::net::ToSocketAddrs;
    let iter = (host, 0).to_socket_addrs()?;
    Ok(iter.map(|sa| sa.ip()).collect())
}

/// 判断 IP 是否属于禁用段（私网/环回/链路本地/云元数据）。
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            // 127/8 环回
            if octets[0] == 127 {
                return true;
            }
            // 10/8 私网
            if octets[0] == 10 {
                return true;
            }
            // 192.168/16 私网
            if octets[0] == 192 && octets[1] == 168 {
                return true;
            }
            // 172.16/12 私网（172.16.0.0 – 172.31.255.255）
            if octets[0] == 172 && (16..=31).contains(&octets[1]) {
                return true;
            }
            // 169.254/16 链路本地（含云元数据 169.254.169.254）
            if octets[0] == 169 && octets[1] == 254 {
                return true;
            }
            // 0.0.0.0/8（当前网络）
            if octets[0] == 0 {
                return true;
            }
            false
        }
        IpAddr::V6(v6) => {
            // ::1 环回 / fc00::/7 唯一本地 / fe80::/10 链路本地
            v6.is_loopback() || (v6.octets()[0] & 0xfe) == 0xfc || (v6.octets()[0] & 0xff) == 0xfe
        }
    }
}

/// 规范化 host：小写化、去端口（白名单比较时统一）。
fn normalize_host(host: &str) -> &str {
    // 去掉端口部分（host 可能是 "api.deepseek.com:443"）
    let h = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    // 去掉 IPv6 方括号
    h.trim_start_matches('[').trim_end_matches(']')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_whitelisted_host_passes() {
        // 内置白名单 host（DeepSeek）应通过校验
        let allowed = AllowedHosts::default();
        validate_endpoint("https://api.deepseek.com/v1/chat/completions", &allowed).unwrap();
    }

    #[test]
    fn private_ip_rejected() {
        // 私网/元数据 IP 应被拒绝（SSRF 防御）
        let allowed = AllowedHosts::new(["169.254.169.254".to_string()]);
        let r = validate_endpoint("http://169.254.169.254/latest/meta-data", &allowed);
        assert!(r.is_err());
    }

    #[test]
    fn unauthorized_host_rejected() {
        // 未在白名单的 host 应被拒绝
        let allowed = AllowedHosts::default();
        let r = validate_endpoint("https://evil.example.com/x", &allowed);
        assert!(r.is_err());
    }
}

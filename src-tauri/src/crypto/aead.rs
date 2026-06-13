//! 认证加密（AES-256-GCM）
//!
//! 流程：
//! - 加密：随机 salt → PBKDF2 派生密钥 → 随机 nonce → AES-256-GCM 加密
//! - 解密：从密文取 salt → 派生密钥 → 取 nonce → 解密验证
//!
//! 密文格式 `EncryptedPayload`（base64 字段，JSON 序列化后落盘）：
//! ```json
//! { "version": 1, "salt": "<base64>", "nonce": "<base64>", "cipher": "<base64>" }
//! ```
//! 明文解密后即用即抛，绝不缓存到结构体字段或全局状态。

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64ct::{Base64, Encoding};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::crypto::kdf::{derive_key, random_salt, SALT_LEN};
use crate::error::AppError;

/// 密文格式版本（未来升级 KDF/AEAD 时递增）
pub const PAYLOAD_VERSION: u32 = 1;
/// AES-256-GCM nonce 长度（标准 12 字节）
pub const NONCE_LEN: usize = 12;

/// 加密后的密文载荷（落盘格式）。
///
/// 所有字节字段以 base64 字符串存储，便于嵌入 JSON。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPayload {
    /// 格式版本
    pub version: u32,
    /// PBKDF2 salt（base64）
    pub salt: String,
    /// AES-GCM nonce（base64）
    pub nonce: String,
    /// 密文（base64，含 GCM 认证标签）
    pub cipher: String,
}

/// 加密：把明文（如 API key）用 password 加密为 `EncryptedPayload`。
///
/// - 每次调用生成新的随机 salt + nonce（相同明文产出不同密文）。
/// - 明文 `plaintext` 仅在此函数栈帧内可见。
///
/// # 返回
/// 可直接 `serde_json::to_string` 落盘的 `EncryptedPayload`。
pub fn encrypt(password: &str, plaintext: &[u8]) -> Result<EncryptedPayload, AppError> {
    // 1. 随机 salt → 派生密钥
    let salt = random_salt();
    let key = derive_key(password.as_bytes(), &salt)?;

    // 2. 随机 nonce
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    // 3. AES-256-GCM 加密
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::Crypto(format!("密钥长度异常: {e}")))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|e| AppError::Crypto(format!("AES-GCM 加密失败: {e}")))?;

    Ok(EncryptedPayload {
        version: PAYLOAD_VERSION,
        salt: Base64::encode_string(&salt),
        nonce: Base64::encode_string(&nonce_bytes),
        cipher: Base64::encode_string(&ciphertext),
    })
}

/// 解密：用 password 从 `EncryptedPayload` 还原明文。
///
/// 明文返回后由调用方即用即抛（如立即作为 HTTP header 发出），
/// 本函数不保留任何明文副本。
pub fn decrypt(password: &str, payload: &EncryptedPayload) -> Result<Vec<u8>, AppError> {
    // 版本校验
    if payload.version != PAYLOAD_VERSION {
        return Err(AppError::Crypto(format!(
            "不支持的密文版本: {}（当前支持 {}）",
            payload.version, PAYLOAD_VERSION
        )));
    }

    // base64 解码
    let salt = decode_b64(&payload.salt, "salt")?;
    let nonce_bytes = decode_b64(&payload.nonce, "nonce")?;
    let ciphertext = decode_b64(&payload.cipher, "cipher")?;

    if nonce_bytes.len() != NONCE_LEN {
        return Err(AppError::Crypto(format!(
            "nonce 长度异常: {}（期望 {NONCE_LEN}）",
            nonce_bytes.len()
        )));
    }
    if salt.len() != SALT_LEN {
        return Err(AppError::Crypto(format!(
            "salt 长度异常: {}（期望 {SALT_LEN}）",
            salt.len()
        )));
    }

    // 派生密钥并解密（GCM 失败=认证失败=密文被篡改/密码错误）
    let key = derive_key(password.as_bytes(), &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::Crypto(format!("密钥长度异常: {e}")))?;

    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| {
            // 不区分「密码错误」与「密文损坏」以免泄露信息
            AppError::Crypto("AES-GCM 解密失败（密码错误或密文损坏）".into())
        })?;

    Ok(plaintext)
}

/// base64 解码工具（统一错误包装）
fn decode_b64(s: &str, field: &str) -> Result<Vec<u8>, AppError> {
    Base64::decode_vec(s).map_err(|e| AppError::Crypto(format!("base64 解码失败（{field}）: {e}")))
}

//! 密钥派生（PBKDF2-HMAC-SHA256，600000 轮）
//!
//! 参数与旧网页版 `key-encryption.ts` 对齐：600000 轮、SHA-256、32 字节输出。
//! 每次 `derive_key` 接收的 password 仅作函数参数，返回即 Drop，不缓存。

use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;

use crate::error::AppError;

/// PBKDF2 迭代轮次（600k，对应旧前端实现 + 当前 NIST 推荐强度）
pub const PBKDF2_ITERATIONS: u32 = 600_000;
/// 派生密钥长度（AES-256 需要 32 字节）
pub const KEY_LEN: usize = 32;
/// salt 长度（随机生成，落盘保存）
pub const SALT_LEN: usize = 16;

/// 用 password + salt 派生 32 字节 AES-256 密钥。
///
/// password 仅在此函数栈帧内可见，返回的字节数组是派生密钥（非 password 本身）。
#[allow(clippy::missing_errors_doc)]
pub fn derive_key(password: &[u8], salt: &[u8]) -> Result<[u8; KEY_LEN], AppError> {
    let mut out = [0u8; KEY_LEN];
    // pbkdf2_hmac 是无返回值的纯计算函数（不会失败，除非硬件异常）
    pbkdf2_hmac::<Sha256>(password, salt, PBKDF2_ITERATIONS, &mut out);
    Ok(out)
}

/// 生成随机 salt（16 字节，使用 `rand::OsRng` 系 CSPRNG）。
pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    salt
}

//! 加密原语模块（赛博战争模拟器 Rust 后端 — 爪牙之一）
//!
//! 职责硬约束：**不存 passphrase，明文即用即抛**。
//! 仅用于加密/解密前端传入的 API key，密文落盘、明文绝不缓存、绝不写日志。
//!
//! 与前端 `src/utils/key-encryption.ts`（旧网页版）参数对齐：
//! - KDF：PBKDF2-HMAC-SHA256，600000 轮，随机 16 字节 salt
//! - AEAD：AES-256-GCM，随机 12 字节 nonce
//!
//! 子模块：
//! - [`kdf`]：密钥派生（PBKDF2）
//! - [`aead`]：认证加密（AES-256-GCM），定义 `EncryptedPayload`

pub mod aead;
pub mod kdf;

pub use aead::{decrypt, encrypt, EncryptedPayload};
pub use kdf::derive_key;

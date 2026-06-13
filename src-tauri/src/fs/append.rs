//! 真追加实现（`OpenOptions::append`，O(1)）
//!
//! 对应审计教训「OPFS 伪追加 O(n²)」——旧网页版每次追加都重写整个文件，
//! 文件越大越慢。这里用操作系统级 `O_APPEND` 打开模式，
//! 内核在文件末尾原子追加，时间复杂度 O(1)。
//!
//! 用于：
//! - `event-log.jsonl`：每回合游戏事件真追加
//! - `diagnostics.log`：错误诊断日志（只写 status code，绝不写 key/payload）

use std::path::Path;

use crate::error::AppError;

/// 追加一行（自动在末尾补 `\n`）。
///
/// 使用 `OpenOptions::new().create(true).append(true)` 打开，
/// 操作系统保证 O_APPEND 模式下的写入原子追加到文件末尾。
///
/// # 参数
/// - `target`: 目标文件路径（不存在会自动创建）
/// - `line`: 单行内容（不含换行符，函数内部补 `\n`）
pub fn append_line(target: &Path, line: &str) -> Result<(), AppError> {
    use std::io::Write;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)
        .map_err(|e| AppError::Fs(format!("打开追加文件失败 {target:?}: {e}")))?;

    // 写入「行 + 换行符」
    writeln!(file, "{line}").map_err(|e| AppError::Fs(format!("追加写入失败: {e}")))?;

    Ok(())
}

/// 追加原始字节（不补换行符，用于二进制追加场景）。
#[allow(dead_code)]
pub fn append_bytes(target: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)
        .map_err(|e| AppError::Fs(format!("打开追加文件失败 {target:?}: {e}")))?;

    file.write_all(bytes)
        .map_err(|e| AppError::Fs(format!("追加字节失败: {e}")))?;

    Ok(())
}

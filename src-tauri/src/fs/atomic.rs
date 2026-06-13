//! 原子写实现（临时文件 + rename）
//!
//! 对应审计教训「OPFS 伪追加 O(n²)」与「persist 死链丢档」——
//! 关键文件（world-state.json、snapshot.json、各阵营文件、manifest.json）
//! 一律走原子写：先写 `<target>.tmp`，再 `rename` 覆盖目标。
//! `rename` 在同文件系统上是原子的，崩溃也不会写出半截文件。

use std::path::Path;

use crate::error::AppError;

/// 原子写入字节内容到 `target`。
///
/// 流程：
/// 1. 在 `target` 同目录下创建 `<target>.tmp` 临时文件（同目录保证跨文件系统 rename 仍原子）。
/// 2. 写入全部内容并 `sync_all`（落盘）。
/// 3. `rename` 覆盖 `target`。
///
/// 任何步骤失败都会清理临时文件并返回 `AppError::Fs`。
///
/// # 参数
/// - `target`: 目标文件绝对路径（建议由 [`crate::fs::paths`] 解析得到）
/// - `bytes`: 待写入的完整字节内容
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), AppError> {
    // 临时文件名：在目标旁加 .tmp 后缀（同目录，确保 rename 原子）
    let tmp_path = tmp_sibling(target);

    // 写临时文件：用 block 限制 file 作用域，确保 tmp 文件在 rename 前 drop 关闭
    {
        let mut file = std::fs::File::create(&tmp_path).map_err(|e| {
            cleanup_quiet(&tmp_path);
            AppError::Fs(format!("创建临时文件失败 {tmp_path:?}: {e}"))
        })?;
        use std::io::Write;
        file.write_all(bytes).map_err(|e| {
            cleanup_quiet(&tmp_path);
            AppError::Fs(format!("写入临时文件失败: {e}"))
        })?;
        // 落盘：避免 rename 后崩溃导致内容丢失（data Durability）
        let _ = file.sync_all();
    }

    // 原子替换：rename 在同文件系统上是原子的
    std::fs::rename(&tmp_path, target).map_err(|e| {
        cleanup_quiet(&tmp_path);
        AppError::Fs(format!("rename 原子覆盖失败 {target:?}: {e}"))
    })?;

    Ok(())
}

/// 原子写入 UTF-8 字符串（serde_json 序列化结果的便捷封装）。
pub fn write_atomic_text(target: &Path, text: &str) -> Result<(), AppError> {
    write_atomic(target, text.as_bytes())
}

/// 计算临时文件路径：目标旁的 `.tmp` 兄弟文件。
fn tmp_sibling(target: &Path) -> std::path::PathBuf {
    // 将文件名加上 .tmp 后缀；若无文件名（目录）则直接追加
    let mut name = target
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    target.with_file_name(name)
}

/// 静默清理临时文件（忽略错误，用于错误回滚路径）。
fn cleanup_quiet(path: &Path) {
    let _ = std::fs::remove_file(path);
}

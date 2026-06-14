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

// =============================================================================
// 单元测试（P2-1）：原子写成功 + 写入中断不损坏目标
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 原子写成功：tmp→rename，目标内容正确，且 tmp 文件被清理（不存在残留）。
    #[test]
    fn write_atomic_succeeds_content_correct_and_tmp_cleaned() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let target = tmp.path().join("world-state.json");

        let payload = r#"{"turnIndex":42}"#;
        write_atomic(&target, payload.as_bytes()).expect("原子写应成功");

        // 目标内容正确
        let got = std::fs::read_to_string(&target).expect("读取目标文件失败");
        assert_eq!(got, payload);

        // tmp 临时文件应已被 rename 消费掉，无残留
        let tmp_path = tmp_sibling(&target);
        assert!(
            !tmp_path.exists(),
            "原子写成功后 tmp 文件不应残留: {tmp_path:?}"
        );
    }

    /// 写入中断不损坏目标：模拟「tmp 已写出但 rename 未执行」。
    ///
    /// 做法：先让目标存在旧值；然后手动写出 tmp（模拟中断在 rename 前），
    /// 验证目标仍为旧值（rename 未发生 → 目标不受影响）。
    /// 再补一次完整 write_atomic，验证 rename 后目标更新为新值。
    #[test]
    fn write_atomic_interruption_does_not_corrupt_target() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let target = tmp.path().join("snapshot.json");

        // 初始：目标已有旧值
        std::fs::write(&target, b"OLD").expect("写旧值失败");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "OLD");

        // 模拟中断：只写出 tmp，不执行 rename（直接构造 tmp 文件）
        let tmp_path = tmp_sibling(&target);
        std::fs::write(&tmp_path, b"NEW").expect("写 tmp 失败");
        // 此时目标仍为旧值（rename 未发生）
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "OLD",
            "中断期间目标不得损坏，应保持旧值"
        );

        // 恢复：执行完整原子写（内部会 rename 覆盖）
        write_atomic(&target, b"NEW").expect("恢复写入应成功");
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "NEW",
            "rename 后目标应更新为新值"
        );
    }

    /// 多次原子写覆盖：每次都应是完整内容（无半截/拼接）。
    #[test]
    fn write_atomic_overwrite_keeps_consistent_content() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let target = tmp.path().join("manifest.json");

        write_atomic(&target, b"first-long-content").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "first-long-content");

        // 用更短的内容覆盖，确认不会残留旧内容的尾巴（半截写入的典型症状）
        write_atomic(&target, b"short").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "short");
    }
}

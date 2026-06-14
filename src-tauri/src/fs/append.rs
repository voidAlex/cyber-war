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

// =============================================================================
// 单元测试（P2-1）：多次 append 顺序正确 + 真追加（不重写已有内容）
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 多次 append 内容顺序正确：文件应是 line1\nline2\nline3\n 的顺序。
    #[test]
    fn append_multiple_lines_preserve_order() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let target = tmp.path().join("event-log.jsonl");

        append_line(&target, "line1").expect("追加 line1 失败");
        append_line(&target, "line2").expect("追加 line2 失败");
        append_line(&target, "line3").expect("追加 line3 失败");

        let got = std::fs::read_to_string(&target).expect("读取文件失败");
        assert_eq!(got, "line1\nline2\nline3\n", "追加顺序与换行应正确");
    }

    /// 真追加（不重写已有内容）：先写定长前缀，再追加，确认前缀字节未被改动。
    ///
    /// 验证手段：记录追加前文件总字节数 P，追加一段后总字节 = P + 追加字节数
    /// （若实现错误地重写/截断，字节数关系不成立）。
    #[test]
    fn append_is_true_append_does_not_rewrite() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let target = tmp.path().join("diagnostics.log");

        let prefix = "PROMPT-CACHE-HIT=100\n";
        append_line(&target, "PROMPT-CACHE-HIT=100").expect("写前缀失败");
        let size_before = std::fs::metadata(&target).expect("读元数据失败").len();
        assert_eq!(
            size_before as usize,
            prefix.len(),
            "前缀字节数应等于写入字节数"
        );

        let extra = "PROMPT-CACHE-MISS=5\n";
        append_line(&target, "PROMPT-CACHE-MISS=5").expect("追加失败");
        let size_after = std::fs::metadata(&target).expect("读元数据失败").len();
        assert_eq!(
            size_after as usize,
            size_before as usize + extra.len(),
            "真追加：追加后字节数 = 追加前 + 新增行字节"
        );

        // 前缀内容仍在文件开头（未被重写）
        let content = std::fs::read_to_string(&target).unwrap();
        assert!(
            content.starts_with("PROMPT-CACHE-HIT=100\n"),
            "已有内容不得被改动: {content:?}"
        );
    }

    /// 追加文件不存在时自动创建。
    #[test]
    fn append_creates_file_if_missing() {
        let tmp = tempfile::tempdir().expect("创建 tempdir 失败");
        let target = tmp.path().join("newfile.log");
        assert!(!target.exists());

        append_line(&target, "first").expect("首次追加应自动创建文件");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "first\n");
    }
}

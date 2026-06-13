/**
 * 诊断日志桩（diagnostics.ts）。
 *
 * 追加 status code / 错误类别到 diagnostics.log（Rust 真追加）。
 * 铁律：diagnostics 只写 status code / 类别，**绝不写 key/payload**。
 *
 * 里程碑：M1（基本诊断）/ M3（错误四分类落盘）。
 *
 * @module layers/persistence/diagnostics
 */

/**
 * 追加一行诊断（只写 status code / 类别，绝不写 key/payload）。
 * TODO(M1/M3): tauriBridge.fsAppendDiagnostics()。
 */
export async function appendDiagnostic(_saveId: string, _line: string): Promise<void> {
  // TODO(M1/M3): 仅含 status code / 类别描述
}

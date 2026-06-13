/**
 * 战役包 ZIP 桩（campaign-zip.ts）。
 *
 * 解包/打包战役包 ZIP，经 gateway/tauri-bridge 调用 Rust fs_unpack_campaign /
 * fs_export_save / fs_import_save（防 zip-slip）。
 *
 * 里程碑：M2（M2 简化版加载验证）/ M4（ZIP 闭环验收）。
 *
 * @module layers/persistence/campaign-zip
 */

/**
 * 解包战役包到 saves/<saveId>/campaign/（防 zip-slip）。
 * TODO(M2/M4): tauriBridge.fsUnpackCampaign()。
 */
export async function unpackCampaign(_saveId: string, _zipPath: string): Promise<void> {
  // TODO(M2/M4): tauriBridge.fsUnpackCampaign()
}

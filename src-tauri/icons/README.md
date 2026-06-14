# 图标说明（占位符 + 生成脚本）

当前 `icons/` 下的图标文件为**占位符**（最小有效 PNG，紫底），仅用于让
`cargo check` / `tauri::generate_context!` 编译通过。

```
icons/
├── 32x32.png          # 任务栏小图标
├── 128x128.png        # 常规尺寸
├── 128x128@2x.png     # 高分屏（Retina）2x
├── icon.icns          # macOS 图标集（当前占位为 PNG 内容）
├── icon.ico           # Windows 图标集（当前占位为 PNG 内容）
└── README.md          # 本说明
```

## 何时替换为正式图标

正式打包发布前，必须用真实图标素材重新生成全套。

## 生成脚本：`pnpm tauri icon <1024 源图>`

Tauri 2 内置 `tauri icon` 子命令，从**一张 1024×1024 PNG 源图**自动生成全平台
全套图标（覆盖 `bundle.icon` 在 `tauri.conf.json` 中列出的每个文件）：

```bash
# 1. 准备一张 1024×1024 的 PNG 源图（建议透明背景，正式品牌图标）
#    放在项目任意位置，例如 ./brand/source-1024.png

# 2. 在项目根目录执行（生成到 src-tauri/icons/，覆盖占位符）
pnpm tauri icon ./brand/source-1024.png

# 等价于（不通过 pnpm 脚本）
# npx @tauri-apps/cli icon ./brand/source-1024.png
```

该命令会自动生成并覆盖：
- `32x32.png` / `128x128.png` / `128x128@2x.png`（Linux/Windows 通用）
- `icon.icns`（macOS 图标集，多分辨率打包）
- `icon.ico`（Windows 多分辨率图标集）
- 以及 `Square*Logo.png` / `StoreLogo.png` 等 Windows Store 相关尺寸（若启用）

源图要求：
- **尺寸**：至少 1024×1024（推荐正方形；Tauri 会缩放到各目标尺寸）。
- **格式**：PNG（支持透明通道）。
- **内容**：正式品牌图标，避免文字过小（缩小到 32×32 时不可读）。

## 为何不阻塞 cargo check

`tauri::generate_context!()` 编译期会读取 `tauri.conf.json` 中 `bundle.icon`
列出的图标文件（文件必须存在且可读），但**不校验图标内容有效性**。
因此占位符 PNG（包括 `.icns`/`.ico` 暂存为 PNG 内容）足以让 `cargo check` 通过；
真实打包阶段 `tauri build` 才会校验格式，届时务必先执行 `tauri icon`。

## 注意事项

- **占位符的 `.icns`/`.ico` 当前为 PNG 内容**（非真实 icns/ico 容器）。
  `cargo check` 不校验容器格式，但 `tauri build` 会——所以**打包前必须**
  先跑 `pnpm tauri icon` 生成真实容器格式的图标。
- 生成脚本跨平台（Linux/macOS/Windows 均可运行），不依赖额外图像处理工具。
- 若需自定义图标集（如不同平台不同图标），手动替换对应文件即可，
  `tauri.conf.json` 的 `bundle.icon` 列表需与实际文件一致。

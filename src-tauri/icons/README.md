# 图标说明（占位符）

当前 `icons/` 下的图标文件为**占位符**（最小有效 PNG，紫底），仅用于让
`cargo check` / `tauri::generate_context!` 编译通过。

## 何时替换为正式图标

正式打包发布前，必须用真实图标素材重新生成全套：

```bash
# 在项目根执行（准备一张 1024x1024 PNG 源图）
pnpm tauri icon path/to/source-1024.png
```

该命令会自动生成 `32x32.png` / `128x128.png` / `128x128@2x.png` /
`icon.icns`（macOS）/ `icon.ico`（Windows）等全套，覆盖此处的占位符。

## 为何不阻塞 cargo check

`tauri::generate_context!()` 编译期会读取 `tauri.conf.json` 中 `bundle.icon`
列出的图标文件（文件必须存在且可读），但**不校验图标内容有效性**。
因此占位符 PNG（包括 `.icns`/`.ico` 暂存为 PNG 内容）足以让 `cargo check` 通过；
真实打包阶段 `tauri build` 才会校验格式，届时务必先执行 `tauri icon`。

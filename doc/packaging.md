# 打包指南（packaging）

> 适用：Tauri 2 桌面应用打包。代码跨平台不改，仅打包环境/命令不同。

赛博战争模拟器是 **Tauri 2** 桌面应用：前端 TS（大脑，全部业务逻辑）+ Rust 后端
（爪牙，仅 fs / LLM 转发 / 加密）。打包产出桌面安装包，**代码跨平台不改**，
区别只在「在哪台机器上跑 `tauri build`」与「目标 triple」。

---

## 0. 前置（所有平台通用）

1. **Node 20+ 与 pnpm 8+**（前端构建）。
2. **Rust 工具链**（stable，rustup 安装）：
   ```bash
   rustup default stable
   rustup update
   ```
3. **依赖安装**（项目根）：
   ```bash
   pnpm install
   ```
4. **图标**：打包前先用正式 1024×1024 源图生成全套（见
   [`src-tauri/icons/README.md`](../src-tauri/icons/README.md)）：
   ```bash
   pnpm tauri icon ./brand/source-1024.png
   ```
   占位符图标足以 `cargo check`，但 `tauri build` 会校验格式，必须先生成。

---

## 1. WSL2 / Linux 打包（deb + AppImage）

WSL2 内可直接打包 Linux 版（开发环境即构建环境）。

### 1.1 Linux 系统依赖

Tauri 2 Linux 打包需要以下系统库（Debian/Ubuntu 系）：

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

> WSLg 自带 WebView（基于 WebKitGTK），开发运行与打包均可在 WSL2 内完成。

### 1.2 打包命令

```bash
# 在项目根（WSL2 内）执行
pnpm tauri build
```

产出位置：`src-tauri/target/release/bundle/`

- **deb 包**：`bundle/deb/cyber-war-simulator_0.1.0_amd64.deb`
  （Debian/Ubuntu 安装：`sudo dpkg -i xxx.deb`）
- **AppImage**：`bundle/appimage/cyber-war-simulator_0.1.0_amd64.AppImage`
  （单文件可执行，`chmod +x xxx.AppImage && ./xxx.AppImage`）

`pnpm tauri build` 等价于：
1. `pnpm build`（前端 `tsc && vite build`，输出 `dist/`）；
2. `cargo build --release`（Rust 后端编译）；
3. Tauri 打包器把 `dist/` + Rust 二进制 + 图标打包成各平台安装包。

### 1.3 仅构建指定目标（加速）

```bash
# 只打 deb（跳过 AppImage）
pnpm tauri build --bundles deb

# 只打 AppImage
pnpm tauri build --bundles appimage
```

---

## 2. Windows 打包（.msi / .exe）

**关键约束**：Windows 安装包（.msi）**必须在 Windows 原生侧打包**（WSL2 无法
交叉编译 Windows 的 WebView2 依赖与 MSI 打包器）。代码本身不改——只是换个环境跑
`tauri build`。

> 见「重写计划 关键风险 #5：WSL 打包」：Linux 版 WSL 内可打；
> Windows 版须 Windows 原生侧 `cargo tauri build`，代码不改。

### 2.1 Windows 环境准备

1. **Windows 10/11 原生**（或 Windows 虚拟机；不用 WSL）。
2. **Rust 工具链**（含 MSVC 目标）：
   ```powershell
   # 用 rustup-init.exe 安装，默认带 host triple（x86_64-pc-windows-msvc）
   rustup default stable
   rustup target add x86_64-pc-windows-msvc
   ```
3. **MSVC 构建工具**：Visual Studio Build Tools 2022（含「C++ 桌面开发」工作负载，
   提供 `link.exe` 与 Windows SDK）。或安装完整 Visual Studio Community。
4. **WebView2**：Windows 11 自带；Windows 10 需安装
   [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
5. **Node 20+ / pnpm 8+**（与 Linux 同）。

### 2.2 打包命令（显式 MSVC 目标）

```powershell
# 在项目根（Windows 原生 PowerShell/CMD）执行
pnpm install
pnpm tauri build --target x86_64-pc-windows-msvc
```

产出位置：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`

- **MSI 安装包**：`bundle/msi/赛博战争模拟器_0.1.0_x64_en-US.msi`
  （WiX 打包，需 .NET 运行时；Tauri 自动调用）
- **NSIS 安装包**：`bundle/nsis/赛博战争模拟器_0.1.0_x64-setup.exe`
  （Tauri 2 默认也产出 NSIS 安装器，无需额外配置）

### 2.3 为何不能在 WSL 内打 Windows 包

- WebView2（Edge 内核）与 Windows SDK 是 Windows 专属依赖，MSVC linker
  在 Linux/WSL 上不可用（即使装 mingw 交叉工具链，Tauri 的 WiX/NSIS 打包器
  仍依赖 Windows 环境）。
- 结论：Windows 安装包请在 **Windows 原生侧**（物理机 / VM / GitHub Actions
  `windows-latest` runner）打包。

---

## 3. 跨平台：代码不改

**核心**：`src/`（前端 TS）与 `src-tauri/src/`（Rust）代码完全跨平台，不包含
任何 `#[cfg(target_os)]` 分支或平台特定 JS。区别只在：

| 维度 | Linux（WSL2） | Windows 原生 |
|---|---|---|
| 打包命令 | `pnpm tauri build` | `pnpm tauri build --target x86_64-pc-windows-msvc` |
| 产出 | deb / AppImage | msi / nsis exe |
| 系统依赖 | WebKitGTK 系统库 | MSVC Build Tools + WebView2 |
| 业务代码 | 不改 | 不改 |

---

## 4. CI / 自动化打包建议

### 4.1 GitHub Actions 矩阵

```yaml
jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            bundles: deb,appimage
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            bundles: msi,nsis
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 8 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }
      - name: Install Linux deps
        if: runner.os == 'Linux'
        run: |
          sudo apt update
          sudo apt install -y libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
      - run: pnpm install --frozen-lockfile
      - run: pnpm tauri build --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
      - uses: actions/upload-artifact@v4
        with:
          name: bundle-${{ matrix.os }}
          path: |
            src-tauri/target/*/release/bundle/**
            src-tauri/target/release/bundle/**
```

### 4.2 发布前检查清单

- [ ] `pnpm tauri icon ./brand/source-1024.png` 已生成正式图标（非占位符）。
- [ ] `npx tsc --noEmit` 与 `pnpm lint` 零 error。
- [ ] `pnpm test` 全绿（含七条 MVP 验收 + 上下文压缩 + 外交趋势）。
- [ ] `src-tauri/tauri.conf.json` 的 `version` 与 `package.json` 一致。
- [ ] Linux 与 Windows 各打一次安装包，在目标系统安装验证可启动。

---

## 5. 开发模式（不打包，快速验证）

```bash
# 任意平台：启动 dev 模式（热重载前端 + Rust 后端）
pnpm tauri dev

# WSL2 内运行 Linux dev（WSLg 显示窗口）
pnpm tauri dev
```

dev 模式不产出安装包，仅用于开发调试。

---

## 6. 日志文件路径（排查问题用）

应用运行时会把**详细日志**落到本地文件，出问题时用户可把这些文件交给开发者排查。

### 6.1 存储根

所有数据（存档 + 配置 + 日志）都在 OS 标准应用数据目录 `app_data_dir` 下：

- **Linux / WSL2**：`~/.local/share/com.cyberwar.simulator/`（或 `$XDG_DATA_HOME` 下）
- **Windows**：`C:\Users\<用户>\AppData\Roaming\com.cyberwar.simulator\`

布局：

```text
<app_data_dir>/
├── config/                  # LLM 配置（provider/endpoint/model，明文）
│   ├── llm-config.json
│   └── api-key.txt          # 仅 keyring 不可用时降级（含明文 key，勿外发）
├── logs/
│   └── app.log              # 全局应用日志（启动/配置/致命错误/未捕获异常）
└── saves/
    └── <saveId>/
        ├── diagnostics.log  # 存档内日志（state/Agent/物理/LLM/用户操作）
        ├── world-state.json
        └── ...
```

### 6.2 两类日志文件

| 文件 | 范围 | 内容 | 何时看 |
|---|---|---|---|
| `logs/app.log` | **跨存档全局** | 应用启动、LLM 配置加载/降级/legacy、致命错误、未捕获异常（window.onerror/unhandledrejection） | 应用启动失败、配置异常、崩溃 |
| `saves/<saveId>/diagnostics.log` | **单个存档** | 该存档的回合编排（phase 转换/persist）、Agent 批次（chief/theater/commander/director）、物理结算、LLM 调用统计、用户操作（命令/推演/外交） | 特定存档回合异常、Agent 行为异常 |

### 6.3 日志格式与安全

- 每条日志为**单行 JSON**：`{ts, level, category, message, context, turn?}`，便于 grep。
  - `category` 为点分路径（如 `orch/turn/persist`、`llm/call/error`、`ui/command/parse`）。
  - `context` 含结构化业务字段（saveId/turn/provider/model/cacheStats 等）。
- **脱敏**：`apiKey` / `payload` / `Bearer` / `token` / `password` 等敏感字段在落盘前
  被替换为 `***`，**绝不写明文 key**（双保险：logger 脱敏 + Rust 不解析内容）。
  - 例外：`config/api-key.txt` 是 keyring 不可用时的降级文件，本身含明文 key
    （仅本地兜底，**请勿随日志外发**）。
- **best-effort**：写日志失败绝不阻塞游戏循环，只 console.warn。

### 6.4 让用户提供日志

排查问题时，请用户：

1. 复现问题（启动/开局/推演/崩溃）。
2. 把 `logs/app.log` 和（若涉及特定存档）`saves/<saveId>/diagnostics.log`
   一起打包发给开发者。
3. 若担心 `config/api-key.txt` 含 key，**只发 logs/ 与 saves/ 下的 .log 文件**即可。


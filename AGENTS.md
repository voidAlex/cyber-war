# 赛博战争 AI 代理指南


## 项目概述

《赛博战争模拟器》(Cyber War Simulator) 是一款由大语言模型（LLM）驱动的硬核大战略与态势推演游戏。

玩家扮演最高统帅，通过自然语言与 AI 参谋长交互，在战争迷雾中进行盲盒博弈。

本项目已完成**完全重写为 Tauri 2 桌面应用**（详见重写计划 `robust-spinning-lampson.md`）。重写动机是旧网页版虽硬指标全绿，但关键环节多为半成品或埋雷（持久化死链、命令无视状态机阶段、Agent 并发破坏确定性、伪流式、OPFS 伪追加、LLM 转发 SSRF、错误分类全错等）。现以 PRD/TDD 为权威蓝图重写：业务逻辑全前端 TS，Rust 后端只做 fs/llm 两件事零业务逻辑（apiKey 经 OS 凭证库 keyring_store 加密保存，去口令），存储落在本地文件系统。

## 技术栈

本项目为 **Tauri 2 桌面应用**：前端 React19+TS+Vite 跑在 Tauri WebView 中，沙盘用 PixiJS，物理引擎跑在 Web Worker，Rust 作桌面后端只做 fs/llm 两件事（apiKey 经 OS 凭证库 keyring_store 加密保存，去口令），存储落在本地文件系统（取代旧的 OPFS）。

- **运行时/壳**: Tauri 2（桌面应用，跨平台）
- **包管理器**: pnpm 8+（前端）/ cargo（Rust 侧）
- **前端构建工具**: Vite 5+
- **前端语言**: TypeScript 5
- **UI 框架**: React 19+
- **沙盘渲染**: PixiJS（WebGL 2D，支持动画/粒子）
- **物理引擎**: Web Worker（隔离主线程）
- **后端语言/壳**: Rust（Tauri 2）
- **存储**: 本地文件系统（Rust fs 原子写 + event-log 真追加，取代 OPFS）
- **测试框架**: Vitest 20+（前端）/ cargo test（Rust 侧）

### 关键依赖

- **前端（package.json）**：`@tauri-apps/api`、`@tauri-apps/plugin-fs`、`react`、`pixi.js`、`zustand`、`ajv`、`seedrandom`
- **Rust 侧（src-tauri/Cargo.toml）**：`tauri`、`reqwest`、`keyring`、`serde`、`zip`、`tokio`

- **插件化**: ZIP 战役包（Rust 安全解包，防 zip-slip）

支持自定义剧本

## 核心架构

总则：**前端 = 大脑**，**Rust = 爪牙**。

### 前端 = 大脑（TDD 六层分层，业务逻辑全在 TS）

所有游戏规则、状态机、领域结算、Agent 编排、物理 Worker、持久化编排都在前端 TS。

- **TDD 六层**（落地在 `src/layers/`）：
  - `ui/`：React — sandbox（PixiJS）/ terminal / dashboard / log-panel / inspector
  - `application/`：state-machine（reducer 纯 + guard）+ orchestrator（turn-orchestrator + persist-gate）+ services（副作用出口）
  - `domain/`：全纯函数 — combat / intelligence / diplomacy / physics-rules / victory
  - `agents/`：protocol + roles（chief/theater/commander/director）+ orchestrator（确定性序）+ director（终裁 + 兜底）
  - `persistence/`：repository / event-log / snapshot / replay / campaign-zip / diagnostics
  - `gateway/`：唯一允许 import `@tauri-apps/api` 的层 — tauri-bridge / llm-client / runtime-config（apiKey 经 OS 凭证库 keyring + 非密钥字段明文 config 会话管理）/ web-mock-* （浏览器 vite dev 降级）
- **沙盘渲染**: PixiJS 2D 网格地图（高亮、路径预演、热力图、动画/粒子）
- **通信终端**: 自然语言对话界面
- **左侧看板**: 部队信息、后勤状态
- **日志台**: 底层事件滚动输出

### Rust = 爪牙（仅三个模块，铁律：零业务逻辑）

`src-tauri/src/` 下只做两件事（apiKey 经 OS 凭证库存取已并入 fs 模块族），任何 command 里出现游戏规则计算即判违规：

- **`fs/`**：本地文件 IO（`atomic.rs` 临时文件+rename 原子写 / `append.rs` OpenOptions::append 真追加 O(1) / `paths.rs`）
- **`llm/`**：LLM 转发（`router.rs` / `stream.rs` reqwest SSE 真流式 / `guard.rs` host 白名单 + 私网/元数据 IP 拒绝 = SSRF 防御 / `retry.rs`）。不缓存 key、不懂 payload、不做游戏判定。
- **`keyring_store/`**：apiKey 经 OS 凭证库存取（基于 `keyring = "2"` crate，Linux secret-service / macOS Keychain / Windows Credential Manager）。不缓存 key、不写日志；keyring 不可用时降级明文文件 + 警告。明文即用即抛。**去口令改造后替代旧 `crypto/`（pbkdf2/aes-gcm 已删）。**

### 纯/React 边界铁律

`domain/`、`agents/protocol/`、`application/state-machine/reducer.ts` 是**纯函数**——不调 Tauri/fetch/crypto，不调 `Date.now()`/随机数，vitest import 时不得拉起任何 Tauri/fetch/crypto，以此保证领域逻辑 100% 可单测且确定性可回放。`gateway/` 是唯一允许 import `@tauri-apps/api` 的层。

### 确定性两层

- **物理层**：纯数值规则 + seed `scenarioSeed:turn:seq`，可重算可复现（CI 比对 event-log 哈希）。
- **导演层**：LLM 输出"记录即真相"，回放从 event-log 读原文、不重算。event-log 每条标 `source:'physics'|'director'|'rule-engine'`。确定性种子只保证物理层。

### 缓存 prompt 分层（吃满 DeepSeek 等硬盘 KV 缓存红利）

| 层 | 稳定性 | 内容 |
|---|---|---|
| **L0 永不变** | 永久 | system prompt（人格/职责/输出 JSON schema/规则文本） |
| **L1 每局不变** | 整局 | 战役数据（地图/阵营/装备库/数值公式），开局后冻结 |
| **L2 每回合变一次** | 每回合 | 当前世界状态摘要、上下文摘要 |
| **L3 每次请求变** | 每请求 | 本条具体指令/本 Agent 任务（回合号/时间戳/UUID 只能放这里尾部） |

强制规则：**system prompt 固定，禁止注入回合号/时间戳/UUID**；战役数据 L1 开局后冻结；多 Agent 共享同一份 L0+L1+L2 前缀互相命中；messages 历史 append-only。禁止前缀插时间戳/UUID、频繁改 system、历史重排序。

  - **配置**: `tsconfig.json`, `vite.config.ts`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
  - **ESLint**: `eslint.config.js`
  - **路径别名**: `@/`、`@agents/`、`@game/`、`@utils/`、`@types/`、`@layers/*`（src/layers）、`@gateway/*`、`@workers/*`

## 构建与 Lint 命令

```bash
# 桌面应用开发（Tauri 2 + Vite，WSLg 下运行 Linux 版）
pnpm tauri dev

# 打包桌面应用（当前平台）
pnpm tauri build

# Windows 包（需在 Windows 原生侧执行，代码跨平台不改）
cargo tauri build --target x86_64-pc-windows-msvc

# Rust 测试
cargo test

# 纯前端开发（仅 web，无 Tauri 能力，调试 UI 用）
pnpm dev

# 纯前端生产构建（仅 web）
pnpm build
# 预览构建
pnpm preview

# Lint 所有 TS/TSX 文件
pnpm lint

# 运行前端测试
pnpm test
# 单个测试文件
pnpm test src/utils/format-currency.ts
pnpm test src/game/state-machine.ts --run  # 隔离运行

pnpm test src/agents/command-parser.ts --run  # 隔离运行

```

## 代码风格指南

### Imports 导入规范
- 使用 path aliases (`@/`, `@agents/`, `@game/`, `@utils/`, `@types/`, `@layers/*`, `@gateway/*`, `@workers/*`)
- **命名导出**:
  - React 组件优先使用 `export default function`
  - 工具函数使用 `export const` 或命名导出
  - 类型定义优先使用 `export type`
  - 放置在 `src/types/` 中
  - 每个文件一个接口/类型
  - 导出 `interface` 作为 barrel 文件
- 保持 barrel 文件小巧且专注
- **`@tauri-apps/api` 仅允许在 `@gateway/*` 层 import**，其它任何层不得直接 import；前端 Tauri 调用一律走 gateway 封装

### TypeScript
- **严格模式**: 始终启用 (`strict: true`)
  - `noUnusedLocals`: true - 捕获未使用的局部变量
  - `noUnusedParameters`: true - 捕获未使用的函数参数（使用 `_` 前缀）
  - `noFallthroughCasesInSwitch`: true - 捕获 switch 穿透
  - `jsx: react-jsx` (需要显式 `react-jsx` 转换)
  - Vite 插件处理 JSX 转换

- **命名约定**:
  - **组件**: PascalCase，文件名（如 `GameState.tsx`, `UnitCard.tsx`）
  - **工具函数**: kebab-case 文件名（如 `format-currency.ts`, `format-date.ts`）
  - **类型**: 使用 interface/type 定义；优先在 `src/types/` 集中管理。

- **状态管理**:
  - 避免在状态变量中使用魔法数字
  - 在文件顶部使用 `const` 声明常量
  - 对于 action types，使用常量或者字符串字面量联合类型

### 错误处理
- **错误四分类**（Rust 侧精确判定，前端不再猜）：按 reqwest `is_connect()/is_timeout()/status()` 分为
  - **Network**：连接级错误
  - **ApiKey**：401/403
  - **LlmError**：其余 4xx/5xx
  - **Timeout**：超时
- **网络错误**: 暂停当前操作，记录到 `diagnostics.log`，显示用户友好的错误消息
- **API Key 错误**: 显示清晰的消息，引导用户检查有效性
- **LLM 错误**: Rust 侧指数退避重试（1s/2s/4s ×3，单请求 30s 超时），3 次失败返回 `degraded:true` 由前端切规则引擎兜底
- **持久化错误**: Rust fs 原子写（临时文件+rename）保证数据完整性；event-log 真追加
- **验证输入**: 在边界验证所有输入，验证类型，检查必需字段
- **日志记录**: 使用适当的日志级别（error, warn, info, debug）
  - 错误和警告使用 `diagnostics.log`
  - 游戏事件使用 `event-log.jsonl`
  - 开发模式使用 `console`
- **安全**: 永远不要在日志、错误或客户端状态中暴露 API keys
- **清理**: 在记录或处理之前清理所有用户输入、文件路径和数据

### 安全约束（桌面化新增，对应审计教训）
- **LLM host 白名单**（`llm/guard.rs`）：endpoint host 必须在白名单（openai / anthropic / deepseek + 设置里由用户加入的 custom）。
- **SSRF 防御**：拒绝私网段（10/8、172.16/12、192.168/16、127/8、169.254/16）和云元数据 IP（169.254.169.254）；生产强制 https。
- **API key 不存储**：仅作函数参数，返回即 Drop；diagnostics 只写 status code，绝不写 key/payload。
- **ZIP 解包防 zip-slip**（`fs/`）：每个 entry 校验无 `..` 且 join+canonicalize 仍在 sandbox 内。
- **真流式不伪造**（`llm/stream.rs`）：reqwest `.bytes_stream()` 真流式透传，绝不攒完整响应、绝不 padding。

## 性能

- **渲染**: 沙盘渲染用 PixiJS（WebGL 2D），在交互阶段保持 60fps
- **物理引擎**: 跑在 Web Worker，隔离主线程不卡 UI
- **流式战报**: Rust reqwest 真流式，TTFT<200ms，结算中段即可见战报流出
- **多 Agent 延迟**: 战区司令 + 敌/盟统帅真并行（sequence 预分配下安全）+ prompt caching 降延迟
    - **大型列表**: 对长列表使用虚拟滚动（日志、单位、事件）

    - **文件 IO**: Rust 本地文件系统真追加 O(1)，原子写保证完整性

    - **内存**: 卸载组件时清理大对象


## 运行环境与兼容性

- **开发环境**: WSL2 + WSLg，开发与运行 Linux 版桌面应用
- **打包**:
  - Linux 版可在 WSL 内打包
  - **Windows .msi 需在 Windows 原生侧打包**（`cargo tauri build --target x86_64-pc-windows-msvc`），代码跨平台不改
- **目标平台**: Windows / Linux 桌面（Tauri 2 WebView，不依赖具体浏览器版本）


## 文档

- **注释**: 为所有公共接口和复杂逻辑使用 JSDoc

- **README**: 添加新命令或更改模式时更新此文件

- **PRD/TDD**: 参考 `doc/prd-v1.0.md` 和 `doc/tech-design-v1.0.md` 了解架构决策（权威蓝图，只读不动）

- **重写计划**: 参考 `robust-spinning-lampson.md` 了解完全重写为 Tauri 2 桌面应用的完整计划与关键决策

- **示例战役包**: 凡尔登战役 1916（`verdun-1916`）为默认示例包，用于加载验证与端到端验收

## 要求

- 给用户回答问题必须使用中文，完成工作后的交付总结也必须用中文
- 用户发出疑问时，必须分析后给用户解决方案的选择，严禁未经确认直接修改文档或代码
- 用户让开始编码前，必须找到当前计划中需要用户澄清的问题，待用户确认后才可开始编码
- 如果用户让排查问题，排查顺序是日志--源码，严禁不通过排查日志和源码直接进行修改，如果缺少问题依据，则需要在关键路径增加日志输出，并告诉用户再次复现；如果是前端无法自行获取日志，则要引导用户告知日志
- 代码必须添加方法级和文件级的中文注释
- 每次对话完后，在结尾加一个“喵~”
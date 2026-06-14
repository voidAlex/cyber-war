# CLAUDE.md — 项目快速上下文卡片

> AI 助手打开本项目时秒懂的精炼入门。详细规范见 `AGENTS.md`，权威蓝图见 `doc/`，完整重写计划见 `plans/`。

## 一句话

LLM 驱动的硬核大战略战争策略游戏，Tauri 2 桌面应用，**完全重写中**（旧网页版代码不保留）。

## 技术栈

- **前端（大脑）**：React 19 + TypeScript + Vite + PixiJS（沙盘渲染）+ zustand（状态）+ ajv（schema 校验）+ seedrandom（确定性随机）
- **后端（爪牙）**：Rust（Tauri 2）+ reqwest（LLM 流式转发）+ keyring（apiKey 经 OS 凭证库加密保存，去口令）
- **存储**：本地文件系统（Rust 原子写 + event-log 真追加），替代旧 OPFS

## 关键命令

| 命令 | 用途 |
|---|---|
| `pnpm tauri dev` | 启动桌面应用开发（WSL2+WSLg 跑 Linux 版） |
| `pnpm tauri build` | 打包生产版（Windows .msi 须 Windows 原生侧打包） |
| `pnpm test` | 前端 vitest（纯函数 + 阶段守卫） |
| `cargo test` | Rust 单测（fs 原子写/追加/keyring_store） |
| `pnpm lint` | ESLint 全量检查 |

## 架构铁律

- **前端 = 大脑**：TDD 六层分层，承载状态机、领域结算、Agent 编排、物理 Worker、持久化编排。
- **Rust = 爪牙**：只做两件事——本地文件 IO / LLM 真流式转发。apiKey 经 OS 凭证库存取（keyring_store）。**Rust 零业务逻辑**。
- **纯函数边界**：`domain/`、`agents/protocol/`、`state-machine/reducer.ts` 必须纯函数，vitest 不得拉起 Tauri/fetch/crypto。`gateway/` 是唯一可 import `@tauri-apps/api` 的层。
- **确定性两层**：物理层（纯数值规则 + seed `scenarioSeed:turn:seq`，可重算可复现，CI 比对 event-log 哈希）；导演层（LLM 输出"记录即真相"，回放直接采信不重算）。
- **缓存 prompt 分层（L0-L3，吃满 DeepSeek 缓存红利）**：L0 永不变（人格/规则）、L1 每局不变（战役数据）、L2 每回合变一次（世界状态摘要）、L3 每请求变（具体指令）。system prompt 禁止注入时间戳/回合号/随机 ID。目标命中率 >80%。
- **apiKey 安全红线（去口令改造后）**：apiKey 明文**仅会话内存**（getSessionConfig），不进 store state 持久字段、不写文件（OS 凭证库 keyring 透明加密 / 降级明文文件兜底除外）。桌面端无应用层 passphrase，重启自动加载。

## 目录速览

```
src-tauri/        Rust 后端：fs/(原子写/真追加) llm/(router/stream/guard) keyring_store/(OS凭证库存取+降级)
src/layers/       六层：ui(application(domain(agents(persistence(gateway
src/types/        前后端权威类型契约
src/workers/      physics.worker.ts（物理引擎，隔离主线程）
doc/              PRD/TDD 权威蓝图（只读，不动）
```

## 里程碑

| M | 可演示交付物 |
|---|---|
| **M1 骨架** | 创建存档、空转状态机、刷新后不丢档 |
| **M2 握手+物理+沙盘** | 自然语言命令、虚线预演、PixiJS 沙盘、数值结算 |
| **M3 Agent+导演部+战报** | 四类 Agent 真流式、导演终裁、规则引擎兜底、回放哈希回归 |
| **M4 情报外交ZIP+凡尔登包+生成器** | 情报4级、外交信任度、ZIP 闭环、战役生成器、7条验收 |

## 权威文档指针

- `doc/prd-v1.0.md` — 产品需求（功能定义）
- `doc/tech-design-v1.0.md` — 技术设计（架构决策）
- `/home/alex/.claude/plans/robust-spinning-lampson.md` — 完整重写计划（决策、防坑对策、里程碑详情）

## 核心工作约束

- **中文回答**；交付总结也用中文。
- **先日志后源码**排查问题；缺依据则加日志让用户复现，前端无法获取日志时引导用户提供。
- 给出**方案选择**，严禁未经确认直接改文档/代码。
- 代码加**方法级和文件级中文注释**。
- 遵守 **Rust 零业务逻辑**铁律；命令接口仅 fs/llm 两类（apiKey 经 keyring_store，非密钥字段经 llm_config_*）。
- 每次对话结尾加 **"喵~"**。

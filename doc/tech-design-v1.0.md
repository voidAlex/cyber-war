# 《赛博战争模拟器》技术设计文档（TDD） V1.0
> **审核修订版 v1.0.2（重写为 Tauri 2 桌面应用）**
> 
> 审核日期： 2026-03-08
> 
> **重写修订说明**：本文档已按"完全重写为 Tauri 2 桌面应用"计划更新——OPFS→本地文件系统（Rust `app_data_dir`，原子写）；后端 Node HTTP→Tauri Rust 后端（仅 LLM 转发 + 本地文件 IO，零业务逻辑）；apiKey 经 OS 凭证库加密保存（去口令改造后替代旧 pbkdf2/aes-gcm，见 §3.8）；新增确定性两层、人格数值基底、DeepSeek v4 + 缓存极致优化、SSRF 防御、内置战役生成器与数据模型 schema。

---

## 1. 设计目标与范围
> 
> ### 1.1 目标
> - 基于自然语言指令构建 WEGO（同步回合制）战争推演闭环。
> - **完全重写为 Tauri 2 桌面应用**：前端承载全部核心业务逻辑与渲染，**Tauri Rust 后端仅做两件事**——① 本地文件 IO ② LLM 真流式转发，**零业务逻辑**（硬约束，见 §1.5）。apiKey 经 OS 凭证库加密保存（见 §3.8）。
> - **持久化介质改为本地文件系统**（Rust `app_data_dir`，**原子写 = 临时文件 + rename**，event-log.jsonl 真追加 O(1)）。OPFS 全部替换，桌面化后 Safari 配额/清除风险消失。
> - 支持 **ZIP 文件导入导出**战役包（放弃 GitHub 在线加载)。
> - 实现多 Agent 层级博弈（玩家侧参谋、战区司令、敌/盟统帅、导演部裁判)。
> - **数值骨架 + LLM 大自由**：数值规则 = 物理真相（可回放/公平/可平衡），LLM = 理解+人格+裁定+润色；导演部可覆写数值但**必须留痕**。
> - **⚠️ 时间线调整**: MVP 范围保持不变，但预计交付周期调整为 **12-16 周**。

> 
> ### 1.2 MVP 范围（已确认)
> - 单人 vs 敌方 AI
> - 盟友外交与不受控盟军
> - 导演部随机事件
> - 战区司令人格与抗命
> - 情报半衰期与残影系统
> 
> ### 1.3 非目标（ V1 不做)
> - 实时制战斗 (RTS)
> - 后端托管用户密钥
> - 复杂 3D 地图与物理引擎
> 
> ### 1.4 审核结论
> 
> | # | 问题 | 严重度 | 决策 |
>---|------|--------|------|
| 1 | PRD vs TDD 真相源矛盾 | 🔴 CRITICAL | **JSON 为唯一真相源**，修改 PRD 对齐 |
| 2 | MVP 范围过大 | 🔴 CRITICAL | **保持现有范围但延期至 12-16 周** |
| 3 | GitHub API 速率限制 | 🔴 CRITICAL | **放弃在线加载，仅用 ZIP** |
| 4 | Safari OPFS 数据清除 / 桌面化 | 🟡 IMPORTANT | **桌面化本地文件系统**（Rust `app_data_dir` 原子写），OPFS 与 Safari 配额/清除风险一并消失 |
| 5 | 命令握手延迟 | 🟡 IMPORTANT | **批量握手 + 真并行 + 缓存**：参谋长批量解析、玩家批量确认；战区/敌盟统帅真并行；prompt caching 降本降延迟 |
| 6 | 上下文膨胀 | 🟡 IMPORTANT | **定期 LLM 摘要压缩**（每 5 回合) |
| 7 | 物理引擎 vs 导演部权限 | 🟡 IMPORTANT | **确定性两层分明**：物理层纯数值规则 + seed 可重算可复现（CI 比对 event-log 哈希）；导演层 LLM "记录即真相"，回放从日志读原文不重算（详见 §3.1） |
| 8 | Agent 人格漂移 | 🟡 IMPORTANT | **人格数值基底**（`CommanderProfile` 加 `aggression`/`obedience`/`preferredTempo`/`doctrineTags`），LLM 在数值约束内发挥，obedience 低时按概率判抗命 |
| 9 | 回合结算等待 UX | 🟡 IMPORTANT | **实时进度 + 流式战报**（TTFT<200ms） |
| 10 | Worker 隔离策略 | 🟢 OPTIMIZATION | **Worker 仅用于物理引擎** |
| 11 | 离线支持 | 🟢 OPTIMIZATION | **离线可玩降级**：无 LLM 时规则引擎（physics-rules + 数值人格）推进游戏，仅失去叙事润色；event-log 标 `source:'rule-engine'`，UI 明示；可选"纯规则引擎模式"（零成本零延迟） |
| 12 | API Key 信任 | 🟢 OPTIMIZATION | **开源 + 明确告知** |
| 13 | Agent 调试机制 | 🟢 OPTIMIZATION | **开发模式 Agent Inspector** |
> 
> ### 1.5 錙误处理流程
> - **网络异常**: 暂停当前回合,提示玩家重试,状态保持一致性。写入 `diagnostics.log`（仅记 status code，不记 key/payload）。
> - **API Key 夛效**: 明确提示,引导用户检查密钥有效性.
> - **LLm 超时**: 指数退避重试(1s/2s/4s,最多 3 次),超时 30s 后降级到规则引擎兜底（event-log 标 `source:'rule-engine'`，UI 明示"降级结算"）。
> - **错误四分类**: 按网络异常 / API Key 失效(401,403) / LLM 错误(4xx,5xx) / 超时 精确分类（详见 §6），前端不再"猜"类别。
> - **离线降级**: 无 LLM 时规则引擎（physics-rules + 数值人格）推进游戏，仅失去叙事润色；可选"纯规则引擎模式"（零成本零延迟）。

 
> ---
## 2. 架构总览
> 
> ### 2.1 逻辑分层
> 1. **UI 层**：沙盘、看板、日志台、通信终端
> 2. **应用层**：回合状态机、命令握手、任务编排
> 3. **领域层**：战斗结算、迷雾情报、外交与人格决策
> 4. **Agent 层**：参谋/司令/统帅/导演部代理协议与执行器
> 5. **持久化层**：**本地文件系统（Rust `app_data_dir`）**、JSON 状态原子写入（临时文件 + rename）、event-log.jsonl 真追加、快照与导入导出
> 6. **网关层（Tauri Rust 后端）**：**仅做两件事**——LLM provider 路由与真流式转发 + 本地文件 IO（含 apiKey 经 OS 凭证库存取）；**零业务逻辑**，不存储密钥
> 
> ### 2.2 运行时组件
> - `Command Interpreter`：自然语言 -> 结构化意图
> - `Intent Validator`：防呆校验验 + 网格预演 + 二次确认
> - `Turn Orchestrator`：Wego 流程控制
> - `Director Referee`：**拥有最终裁定权**,非法指令拦截 + 事件编排 + 战报生成
> - `Physics Engine (Worker)`：数值计算、损失/补给/机动规则（运行在独立 Worker 中)
> - `Memory Retrieval`：JSON 状态检索、摘要拼装、上下文预算
> - `Agent Inspector (开发模式)`：实时查看每个 Agent 的 prompt/输出/决策过程
> 
> ---
## 3. 核心设计
> 
> ### 3.1 回合状态机（WEGO)
> ```text
> IDle
>   -> planning (玩家观察/对话/下令)
>   -> handshake (参谋反问 + 预演虚线 + 玩家确认)
>   -> locked (双方计划冻结)
>   -> resolution (导演部接管结算)
>   -> briefing (战报分发 + 沙盘更新 + 情报半衰)
>   -> persist (JSON 状态落盘 + 快照)
>   -> idle (next turn)
> ```
> 
> 状态机要求：
> - 每阶段输入/输出固定,支持回放与重算.
> - 阶段失败可重试,失败原因写入系统日志.
> - 回合结算使用确定性随机种子 (`scenarioSeed + ':' + turnIndex + ':' + sequence`)。
>
> **确定性两层分明**（关键设计，修订决策#7）：
> - **物理层**：纯数值规则 + seed（`scenarioSeed:turn:seq`），**可重算、可复现**。固定种子下，CI 比对 event-log 哈希逐 PR 回归（验收#7 红线）。物理层的随机数全部来自 seedrandom 封装，与调度顺序无关。
> - **导演层**：LLM 输出"**记录即真相**"。回放时**从 event-log 读原文、不重算**，不重新调用 LLM。
> - **event-log 每条标注 `source` 字段**：`source:'physics'`（数值结算）/ `source:'director'`（LLM 裁定+叙事）/ `source:'rule-engine'`（降级兜底）。
>   - 回放规则：`physics` 类校验重算一致（漂移即告警）；`director` / `rule-engine` 类直接采信日志原文。
> - **明确**：确定性种子**只保证物理层**；导演层由"记录即真相"保证可复现，而非靠 LLM 输出稳定。
> 
> ### 3.2 命令握手协议
> - 玩家输入自然语言命令
> - 参谋 Agent 解析并生成候选结构化命令
> - UI 沙盘显示预演（例如 c3 虚线路径)
> - 玩家 `[确认执行] 后入队到 `pending-orders.json`
> - 未确认命令不可进入结算阶段
> 
> ### 3.3 多 Agent 分层
> - **参谋长 Agent (玩家侧)**：语言解释、风险提示、命令澄清
> - **战区司令 Agent (多阵营)**：目标分解、战术下推、人格偏置决策
> - **统帅 Agent (敌/盟)**：阵营战略决策与外交响应
> - **导演部 Agent (裁判)**：**拥有最终裁定权**,可调整物理引擎结果。 处理玩家的"超常规奇招", 生成天气突变等随机事件, 将战损润色为沉浸式战报.
>
> **人格数值基底**（修订决策#8，对抗"纯 LLM 自由发挥"的长期漂移）：
> - 每个 Agent 的指挥官带 `CommanderProfile`，含数值字段：`aggression`（攻击性）/`obedience`（服从度）/`preferredTempo`（偏好节奏 methodical/balanced/aggressive）/`doctrineTags[]`（教义标签）。
> - LLM 在数值约束内发挥；`obedience` 低时导演部按概率判抗命（数值锚，非纯随机漂移）。人格有数值基底可平衡、可回放。
> 
> Agent 交互统一使用 `Agent Action Envelope`:
> ```json
> {
> "turn": 12,
            "faction": "blue",
            "agentId": "blue-theater-1",
            "intent": "capture_node",
            "payload": {"node": "C3", "units": ["arm-1"]},
            "confidence": 0.78,
            "requiresConfirmation": false
            }
> ```
> 
> ### 3.4 Agent 编排流程与延迟优化)
> 
> **结算阶段 Agent 执行顺序**：
> 1. 参谋长 Agent (玩家侧) - ~3.5s
> 2. 战区司令 Agents (并行) - ~3.5s
> 3. 敌方/盟友统帅 Agent - ~3.5s (可与步骤 2 并行)
> 4. 导演部 Agent (裁判) - ~4.0s
> 
> **总延迟**: ~11-15 秒
> 
> **优化策略**:
> - 战区司令和敌方统帅可并行执行
> - 使用流式输出降低感知延迟 (TTFT < 200ms)
> - UI 显示实时进度条和每个 Agent 的状态
> - **批量握手取代逐条确认**：参谋长 Agent 批量解析玩家多条命令，玩家批量确认（决策#5），消除逐条往返延迟。
> - **prompt caching**：system prompt / 人格 / 历史 / 战役数据作为稳定前缀共享，降本降延迟（详见 §9）。
> 
> **确定性 sequence 预分配**（修订决策#9，对抗"并发抢序破坏确定性"）：
> - sequence 在**派发时预分配**，按批次固定段位，**与调度/完成顺序无关**：
>   - 参谋长批次：`seq` 从 `0+` 起分配
>   - 战区司令批次：`seq` 从 `1000+` 起分配
>   - 敌/盟统帅批次：`seq` 从 `2000+` 起分配
>   - 导演部：`seq` 从 `3000+` 起分配
> - seed = `scenarioSeed + ':' + turnIndex + ':' + sequence`。即使战区与敌盟**真并行**执行，各 Agent 拿到的 sequence 与 seed 仍稳定，回放 event-log 哈希一致。
> 
> ### 3.5 存储与账本 (本地文件系统)
> 
> 目录结构：
            ```text
> /saves/{saveId}/
            /world/
                world-state.json        # 唯一真相源
                turn-snapshot.json      # 回合快照
                event-log.jsonl        # 事件日志(机器可读)
            /factions/{factionId}/
                ledger-audit.md         # 审计日志(人类可读)
                context-summary.md      # 上下文摘要(LLM 输入)
            /system/
                diagnostics.log        # 诊断日志
            manifest.json
> ```
> 
> 设计原则:
            - **JSON 为真相源**: `world-state.json` 是游戏状态的唯一权威来源
            - **Markdown 仅辅助**: 用于审计、日志、 LLM 上下文组装
            - **上下文压缩**: 每 5 回合由导演部 Agent 生成"当前态势总结",替代原始账本
            - **原子写入（Rust fs 原子写）**: 写入临时文件 + rename 提交（`fs/atomic.rs`），防止中断损坏
            - **event-log 真追加 O(1)**: Rust `OpenOptions::append`（`fs/append.rs`），替代 OPFS 伪追加 O(n²)
            - **回放从日志恢复（验收#7 红线）**: event-log 是回放真相源，physics 类校验重算一致，director/rule-engine 类直接采信原文，绝不重新调用 LLM
> 
> ### 3.6 上下文压缩策略
> 
> **触发条件**: 每 5 回合
> 
> **执行者**: 导演部 Agent (在 BRIEFING 阶段)
> 
> **流程**:
> 1. 读取最近 5 回合的 `ledger-audit.md`
> 2. Llm 生成"当前态势总结"(~500 tokens)
> 3. 更新 `context-summary.md`
> 4. 后续回合使用摘要作为上下文输入
> 
> **成本影响**: 摘要产出后作为**新的稳定 L2 前缀**（见 §9.3），旧历史压缩进摘要不再逐条放——既控制上下文膨胀，又**提升缓存命中率**（防前缀漂移）。压缩调用本身按 v4-flash 计价，30 回合战役约 6 次压缩，成本可忽略。
> 
> ### 3.7 回合结算延迟优化
> 
> **目标**: 结算阶段 11-15 秒延迟的玩家体验优化
> 
> **方案**: 实时进度 + 流式战报
> 
> **UI 组件**:
> - **进度条**: "战况推演中... (1/5 敌方司令决策中...)
)"
> - **Agent 状态面板**: 每个 Agent 的实时状态
            - ⏳ 等待中
            - 🔄 处理中
            - ✅ 完成
            - ❌ 失败
            - **流式战报区**: 导演部生成战报时流式输出
            - **可取消按钮**: 鷳过动画(如果已缓存结果)
> 
> ### 3.8 apiKey 本地存储策略（OS 凭证库，去口令改造后）
> - **无应用层 passphrase**：桌面端单用户场景，passphrase 口令解锁边际价值低（能读磁盘往往能 dump 内存、每次输口令烦），改用 **OS 凭证库**（Linux Secret Service / macOS Keychain / Windows Credential Manager）透明加密，桌面端无需口令、重启自动加载。
> - **使用 Rust `keyring_store` 模块**（`src-tauri/src/keyring_store.rs`，基于 `keyring = "2"` crate）：service 名固定 `cyber-war-simulator`、account 名固定 `llm-api-key`。`save(app, api_key)` / `load(app)` / `delete(app)` 三函数；keyring 调用一律包 `tokio::task::spawn_blocking`（D-Bus 同步阻塞）。
> - **降级路径（关键）**：keyring 不可用时（WSL2/Linux 无 Secret Service daemon，返回 `keyring::Error::PlatformFailure`）→ 明文存 `<app_data_dir>/config/api-key.txt` + 返回 `KeyStoreOutcome.warning`（含失败原因 + 降级文件路径，**绝不包含 apiKey**）；`load` 先试 keyring 再试降级文件；`delete` 幂等清理两位置。
> - **非密钥字段明文 config**：provider/endpoint/model 经 `llm_config_read` / `llm_config_write` 明文 JSON 落盘 `<config>/llm-config.json`（Rust 原子写，无敏感性）。
> - **仅会话内内存持有明文 apiKey**：加载后存会话内存（`runtime-config.ts` 单例 session），`clearSession()` 立即置空；apiKey 不进 store state 持久字段、不写 world-state/event-log/snapshot/diagnostics。**明文即用即抛，Rust 不缓存**（key 仅作函数参数，返回即 Drop）。
> - **旧版迁移（legacy）**：检测到旧版 `encryptedApiKey` 字段 → 提示"检测到旧版加密配置（口令已废弃），请重新输入 API Key"，预填 provider/endpoint/model（旧文件这些明文仍可用）→ 用户输新 apiKey → `saveConfig` 覆盖新格式（完成一次性迁移）。不提供旧口令解密路径（passphrase UI 已删，且易丢）。
> 
> > **安全说明**：apiKey 经 OS 凭证库加密保存（OS 透明加密），比应用层 passphrase + PBKDF2/AES-GCM 更贴合桌面（无口令、防静态泄露、跨进程隔离）。降级明文文件仅在 keyring 不可用时启用，UI 顶部显示警告。crypto 原语（pbkdf2/aes-gcm）已从依赖中移除。
> 
> ### 3.9 战役插件: zip 导入导出
> - **导入**: 校验 zip 结构与 schema 后写入本地文件系统
> - **导出**: 将当前存档与战役差量打包 zip
> - **格式校验**: 强制 manifest + schema 校验 + 安全解包规则
> - **安全解包防 zip-slip（Rust `fs_unpack_campaign`）**: 每个 entry 校验路径**无 `..`**，且 `join` + `canonicalize` 后仍位于 sandbox 目录内；任一校验失败即拒绝整个包。防止恶意 zip 通过相对路径越权写入。
> 
> 战役包结构:
            ```text
> campaign/
            manifest.json
            map.json
            factions.json
            units.json
            commanders.json
            rules.json
            victory.json
> ```
> 
> ### 3.10 数据模型 schema（前后端权威契约，`src/types/`）
> 
> 本节补全 §3 各处留白的实体字段定义，作为 TS 类型层与 Rust 持久化的权威契约。
> 
> **WorldState**（唯一真相源）：
> `saveId` / `scenarioId` / `scenarioSeed` / `turnIndex` / `inGameDate` / `factions{}` / `units{}` / `map`(GameMap) / `intel{}` / `diplomacy` / `directorMemory` / `pendingOrders[]` / `lockedOrders{}` / `lastResolution` / `contextSummaries{}`
> 
> **GamePhase**（枚举）：`idle | planning | handshake | locked | resolution | briefing | persist`
> 
> **Faction**：`id` / `side`（player / enemy / ally / neutral）/ `commander`（CommanderProfile：personality / aggression / obedience）/ `theaterCommanders[]` / `supply` / `trust{}`（外交信任度，见下）/ `doctrineTags[]`
> 
> **CommanderProfile**（人格数值基底，见 §3.3）：`personality` / `aggression`（攻击性）/ `obedience`（服从度，低时导演部按概率判抗命）/ `preferredTempo`（methodical / balanced / aggressive）/ `doctrineTags[]`
> 
> **Unit**：`id` / `factionId` / `type` / `coord` / `strength` / `personnel` / `fuel` / `ammo` / `morale` / `fatigue` / `detection`（byFaction：level + lastSeenTurn）/ `orders[]` / `status` / `deception?`
> 
> **GameMap**：`gridType`（square / hex）/ `cols` / `rows` / `cells[]`（`{id, terrain, movementCost, defenseBonus, isObjective}`）/ `highValueNodes[]`
> 
> **ActionEnvelope**（Agent 行动信封）：`turn` / `faction` / `agentId` / `agentRole` / `intent` / `payload` / `confidence` / `requiresConfirmation` / **`sequence`**（预分配序号，见 §3.4）/ `state`
> 
> **情报 4 级**（语义统一：数大=清晰）：
> - `Level 0` 盲区 / `Level 1` 热力脉冲 / `Level 2` 编制确认 / `Level 3` 全量透视
> - **半衰**：`halfLifeTurns = 3`；recon 命中刷新 `lastSeen`，超过半衰降级并显示残影 + `[T-Nh]` 标记。
> 
> **外交信任度**：`0..100` 数值规则
> - 起步：盟友 `60` / 中立 `50` / 敌对 `5`
> - 履约 `+5~10`，毁约 `-15~25`
> - `<30`：盟友请求拒绝率陡升；`<15`：可能倒戈（导演部随机事件）
> 
> **战役包七文件**：manifest / map / factions / units / commanders / rules / victory（详见 §3.9）。
> 
> ### 3.11 内置战役生成器 Agent 编排（M4/M5 交付）
> 
> 游戏内置**战役生成器**：玩家用自然语言提需求（历史战役名 / 时段地区 / 自定义约束），通过接入的 LLM + 多 Agent，**基于历史事实**自动生成符合七文件 schema 的可玩战役包，导入即玩。复用主游戏 Agent 编排基础设施（确定性 sequence、缓存分层、规则引擎兜底、Agent Inspector）。
> 
> **生成流程（多 Agent 协作）**：
> 1. **史实研究员 Agent**：以 **LLM 内置知识为主**（快、可离线、契合单机桌面定位，Rust 后端无需联网能力），查战役的时间 / 双方 / 指挥官 / 地理 / 兵力 / 关键节点 / 胜负。著名战役足够；冷门/不确定事实由平衡校验 Agent 标注"存疑"并提示玩家核对；虚构/自定义战役明确标注"非史实"。
> 2. **战役设计师 Agent**（复用导演部角色）：把史实转游戏机制——map（地理网格 + 高价值节点）/ factions / units / commanders（人格数值）/ rules / victory。
> 3. **平衡校验 Agent**：检查数值平衡、胜利条件可达、规模合理，必要时迭代修正。
> 4. **schema 校验 + 兜底**：生成结果用 `campaign-schemas/` 的 ajv 严格校验；校验失败反馈 Agent 修正，多次失败降级为模板包。
> 
> **设计要点**：
> - **玩家确认**：生成后预览 / 编辑再确认导入，不直接覆盖。
> - **史实幻觉控制**：研究员 Agent 标注关键事实来源；虚构 / 自定义战役明确标注"非史实"。
> - **缓存优化**：生成器 prompt 的"七文件 schema 定义 + 生成规则 + 历史校验规则"是**固定 L0 前缀**，多 Agent 共享 → 高缓存命中（吃满 DeepSeek 缓存红利）。玩家需求放 L3 尾部。
> - **确定性**：生成包带固定 seed、生成后可回放；生成过程允许非确定（LLM 创作），产物固化即可。
> - **成本**：一次性较高 token 消耗，但生成一次可反复玩；用 v4-flash + 缓存降本。
> 
> **里程碑归属**：M4（或 M5 扩展）交付。前提：M3 多 Agent 编排基础设施就绪。
> 
> ---
## 4. 前端 ui/ux 技术实现
> 
> - **中央**: 网格沙盘(高亮、路径预演、热力层、残影层)
> - **右侧**: 通信终端(流式输出、命令确认按钮、战报点击联动)
            - **左侧**: 部队建制、补给、盟友信任度仪表
            - **底部**: 引擎日志台(细颗粒事件时间线)
> 
> **性能要求**:
> - 沙盘渲染目标 60fps (交互期)
            - 回合结算阶段允许降帧但需可取消/恢复
            - 大日志分页虚拟滚动
> 
> ---
## 5. 错误处理与恢复
> 
> - **网络异常**: 暂停当前回合,提示玩家重试,状态保持一致性.写入 `diagnostics.log`（仅记 status code）.
            - **llm 超时**: 重试(指数退避 1s/2s/4s, 最多 3 次) + 降级到规则引擎兜底（event-log 标 `source:'rule-engine'`，UI 明示）
            - **错误四分类**: 网络异常 / API Key 失效(401,403) / LLM 错误(4xx,5xx) / 超时（详见 §6）
            - **api key 失效**: 明确提示,引导用户检查密钥有效性
            - **存档损坏**: 从最近快照恢复 + 校验修复流程（Rust 原子写降低损坏概率）
> 
> ---
## 6. 安全与合规
> 
> - **Tauri Rust 后端仅转发，不持久化用户密钥**；key 仅作函数参数，返回即 Drop（绝不缓存明文）
            - **开源**: 后端代码开源,供用户审计
            - **明确告知**: 用户界面明确说明密钥仅用于 llm 调用,不被存储
            - 战役内容做 schema 校验(防止恶意脚本注入)
            - 关键操作审计: 回合锁定、导入导出、密钥解锁写审计日志
> - **host 白名单 + 私网/元数据 IP 拒绝（防 SSRF，Rust `llm/guard.rs`）**：
>   - endpoint host 必须在白名单（openai / anthropic / deepseek + 用户在设置里加入的 custom），非白名单直接拒绝转发。
>   - **拒绝私网段**：`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`，以及**云元数据 IP `169.254.169.254`**（防云实例凭证窃取）。生产强制 https。
>   - Rust 后端是唯一网络出口，前端无直接 fetch，杜绝"开放中继 SSRF"。
> - **diagnostics 只写 status code**：错误日志绝不写 key / payload；仅记录 HTTP 状态码与错误类别。
> - **错误四分类（Rust `error.rs`，按 reqwest `is_connect()/is_timeout()/status()` 精确分类）**：
>   - **Network**：连接失败 / DNS 失败 / 中断
>   - **ApiKey**：HTTP `401` / `403`
>   - **LlmError**：HTTP 其他 `4xx` / `5xx`
>   - **Timeout**：请求超时
> - 前端不再"猜"错误类别（修正旧版 401 误报网络中断的教训），统一以 Rust 四分类为准。
> 
> ---
## 7. 测试与验收
> 
> ### 7.1 测试层次
> - 单元测试: 命令解析、规则计算、情报衰减
            - 集成测试: wego 整回合流程(规划->结算->持久化)
            - 回归测试: 固定种子回放,确保结果一致
            - 端到端: 导入战役、执行 3 回合、导出并再导入恢复
> 
> ### 7.2 验收标准 (mvp)
> 1. 玩家命令必须经过"反问+确认"才可执行
            2. 双方指令锁定后,导演部裁定能产出可回放战报
            3. 情报半衰期与残影按规则生效
            4. 本地 fs 静默存档可在**关闭应用重开后恢复**（Rust 原子写，刷新/中断不丢档）
> 5. zip 导入导出闭环成功
> 6. **网络异常时游戏状态保持一致性**
            7. **导演部输出写入 event-log,回放时从日志恢复而非重新调用 llm**
> 
> ---
## 8. 开发调试工具
> 
> ### 8.1 Agent Inspector (开发模式)
> 
> **功能**: 实时查看每个 Agent 的决策过程
> 
> **显示内容**:
> - 完整 prompt (system + context + history)
            - 原始 llm 输出
            - 解析后的结构化命令
            - 决策置信度
> 
> **触发方式**: 开发模式自动显示,生产模式隐藏
> 
> ### 8.2 日志系统
> - `diagnostics.log`: 错误、警告、异常
            - `event-log.jsonl`: 所有游戏事件(机器可读)
            - Console 输出: 开发模式下详细日志
> 
> ---
## 9. 成本估算（DeepSeek v4 + 缓存极致优化）
> 
> ### 9.1 推荐供应商：DeepSeek v4（默认）
> - **deepseek-v4-flash**：默认供应商。便宜、并发高(2500)、支持非思考/思考模式切换（`thinking:{type:"enabled"}` + `reasoning_effort`）。OpenAI 兼容格式，base_url `https://api.deepseek.com`。
> - **deepseek-v4-pro**：高质量决策，并发 500。仅用于**导演部终裁、关键超常规奇招**等需要强推理的场景。
> - **注意**：`deepseek-chat` / `deepseek-reasoner` 于 **2026/07/24 弃用**，新项目直接用 v4-flash 的非思考/思考模式。
> - welcome-screen 供应商选择：DeepSeek 设为**推荐默认**（仍保留 openai / anthropic / custom）。
> 
> ### 9.2 v4 价格（基准 6 agent/回合，3000 input + 750 output tokens）
> 
> 
> | 模型 | 输入命中 | 输入未命中 | 输出 |
> |------|---------|-----------|------|
> | **deepseek-v4-flash**（默认） | ￥0.02/M | ￥1/M | ￥2/M |
> | **deepseek-v4-pro**（导演部关键终裁） | ￥0.025/M | ￥3/M | ￥6/M |
> 
> ### 9.3 缓存极致优化（DeepSeek 硬盘 KV cache，命中价是未命中的 1/50~1/120）
> DeepSeek 上下文硬盘缓存默认开启：**后续请求必须完整匹配已落盘的"缓存前缀单元"才命中**。优化核心 = 让 prompt 前缀**稳定且跨请求重复**。
> 
> **prompt 分层**（`agents/context-builder.ts` 按"稳定→易变"构造 messages）：
> 
> | 层 | 稳定性 | 内容 | 缓存价值 |
> |---|---|---|---|
> | **L0 永不变** | 永久 | 角色 system prompt（人格/职责/输出 JSON schema/规则文本） | 最高，必须完全固定 |
> | **L1 每局不变** | 整局 | 战役设定/地图/阵营/装备库/数值规则公式 | 高，开局后冻结 |
> | **L2 每回合变一次** | 每回合 | 当前世界状态摘要、上下文摘要（每 5 回合压缩产出） | 中，同回合多 Agent 共享 |
> | **L3 每次请求变** | 每请求 | 本条具体指令/本 Agent 具体任务 | 低，必然未命中 |
> 
> **强制规则**：
> 1. system prompt 严格固定，**禁止注入回合号/时间戳/随机 ID**（这些只能放 L3 尾部）。
> 2. 战役数据(L1)开局后冻结作为稳定前缀。
> 3. 多 Agent **共享同一份 L0+L1+L2 前缀**（参谋/战区/导演部用相同的世界状态上下文前缀），互相命中。
> 4. 上下文摘要(每 5 回合)产出后作为新的稳定 L2 前缀，旧历史压缩进摘要不再逐条放（防前缀漂移）。
> 5. messages 历史 append-only（多轮对话天然命中）。
> 
> **反缓存模式（禁止）**：前缀插时间戳/UUID/动态回合号；频繁改 system prompt；历史消息重排序。
> 
> **可观测**：读 DeepSeek 返回 usage 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，Agent Inspector 展示每次命中率 + 累计成本；**优化指标目标：命中率 >80%**。
> 
> ### 9.4 成本估算（v4-flash，80% 缓存命中）
> - 基准 6 agent/回合、3000 输入 + 750 输出，命中率 80%（2400 命中 / 600 未命中）：
>   - 输入 = 2400×0.02/1e6 + 600×1/1e6 ≈ ￥0.000648
>   - 输出 = 750×2/1e6 = ￥0.0015
>   - **每回合 ≈ ￥0.0021，30 回合 ≈ ￥0.064**
> - 对比 0% 命中：每回合 ￥0.0045、30 回合 ￥0.135。缓存优化省 50%+，命中率越高省越多（价差 50-120 倍）。
> - pro 约贵 3 倍，仅导演部关键终裁使用。
> 
> ### 9.5 对 Rust 后端的影响
> - `llm/router.rs`：DeepSeek 走 OpenAI 兼容分支（base_url `https://api.deepseek.com`，`Authorization: Bearer`）。
> - `llm/guard.rs`：host 白名单加 `api.deepseek.com`。
> - `llm/stream.rs`：透传 usage（流式末帧含 usage）回传前端统计命中率；payload 支持思考模式字段（导演部/pro 调用时加 `thinking:{type:"enabled"}` + `reasoning_effort`）。
> 
> **建议**: prompt caching 已纳入 §9.3 的分层设计与强制规则，配合 Rust `llm/stream.rs` 透传 usage 可在 Agent Inspector 持续追踪命中率（目标 >80%）。
> 
> ---
## 10. 錙误处理与恢复
> 
> - **网络异常**: 暂停当前回合,提示玩家重试,状态保持一致性
            - **llm 超时**: 指数退避重试(1s, 2s, 4s),最多 3 次；超时降级到规则引擎兜底（event-log 标 `source:'rule-engine'`，UI 明示）
            - **错误四分类**: 网络异常 / API Key 失效(401,403) / LLM 错误(4xx,5xx) / 超时（详见 §6）
            - **api key 失效**: 明确提示,引导用户检查密钥有效性
            - **存档损坏**: 从最近快照恢复 + 校验修复流程（Rust 原子写降低损坏概率）
> 
> ---
## 11. 可行性检索要点 (审核后更新)
> 
> 本地仓库现状: 当前仅 prd,属于绿地项目。
> 
> 本地文件系统（Rust `app_data_dir`）、Rust keyring（OS 凭证库 + 降级明文文件兜底）、zip、agent 编排与状态机方案均有可行实现路径。
> 
> 高风险主要集中于:
> - 回放漂移(重复调用 llm) → **对策: 仅重放命令与 seed + LLM 产物只读 log 不重算 + CI event-log 哈希门（详见 §3.1）**
            - 跨阵营情报泄露(检索隔离不严) → **对策: faction 级命名空间与检索 acl**
            - 场景版本漂移(git 未固定版本) → **对策: zip 格式固定版本**
            - **人格漂移** → **对策: 人格数值基底（CommanderProfile 数值字段）+ prompt 锚定**
            - **SSRF（开放中继）** → **对策: Rust host 白名单 + 私网/元数据 IP 拒绝（详见 §6）**
            - **结算等待 11-15s** → **对策: 实时进度 + 流式战报（TTFT<200ms）+ 战区/敌盟真并行 + prompt caching**
> 
> ---
## 12. 里程碑（已调整）
> 
> - **m1 (3 周)**: 项目骨架 + 状态机 + **本地 fs 存储底座（Rust 原子写/真追加）**
            - **m2 (3 周)**: 命令握手 + 物理引擎最小结算 + 沙盘基础渲染 + **凡尔登 1916 示例包（简化版：验证沙盘 + 结算）**
            - **m3 (4 周)**: 多 agent 编排 + 导演部 + 战报系统
            - **m4 (2-3 周)**: 情报半衰、外交、zip 战役包、验收测试 + **凡尔登 1916 完整版（含情报/外交）** + **内置战役生成器（M4 首发，M5 扩展）**
> 
> **总计**: 12-13 周 (根据审核结论调整)
> 
> ---
## 13. 审核结论
> 
> | # | 问题 | 严重度 | 决策 |
            |---|------|--------|------|
            | 1 | prd vs tdd 真相源矛盾 | 🔴 critical | **json 为唯一真相源**,修改 prd 对齐 |
            | 2 | mvp 范围过大 | 🔴 critical | **保持现有范围但延期**至 12-16 周 |
            | 3 | github api 速率限制 | 🔴 critical | **放弃在线加载,仅用 zip** |
            | 4 | safari opfs 数据清除 / 桌面化 | 🟡 important | **桌面化本地文件系统**（Rust `app_data_dir` 原子写），OPFS 与 Safari 配额/清除风险一并消失 |
            | 5 | 命令握手延迟 | 🟡 important | **批量握手 + 真并行 + 缓存**：参谋长批量解析、玩家批量确认；战区/敌盟真并行；prompt caching 降本降延迟 |
            | 6 | 上下文膨胀 | 🟡 important | **定期 llm 摘要压缩**(每 5 回合) |
            | 7 | 物理引擎 vs 导演部权限 | 🟡 important | **确定性两层分明**：物理层纯数值规则 + seed 可重算可复现；导演层 LLM "记录即真相"，回放从日志读原文不重算（详见 §3.1） |
            | 8 | agent 人格漂移 | 🟡 important | **人格数值基底**（`CommanderProfile` 数值字段），LLM 在数值约束内发挥，obedience 低时按概率判抗命 |
            | 9 | 回合结算等待 ux | 🟡 important | **实时进度 + 流式战报**（TTFT<200ms） |
            | 10 | worker 隔离策略 | 🟢 optimization | **worker 仅用于物理引擎** |
            | 11 | 离线支持 | 🟢 optimization | **离线可玩降级**：无 LLM 时规则引擎推进游戏，UI 明示"降级结算"；可选"纯规则引擎模式"（零成本零延迟） |
            | 12 | api key 信任 | 🟢 optimization | **开源 + 明确告知** |
            | 13 | agent 调试机制 | 🟢 optimization | **开发模式 agent inspector** |
> 
> ### 13.1 文档修改清单
> 
> **prd 修改**:
> - Section 2: 修改数据持久化描述 (JSON 为真相源)
            - Section 9: 删除 github 加载,改为 zip
            - Section 4: 补充导演部最终权力说明
            - Section 3: 补充回合结算延迟优化
            - 添加审核结论章节
> 
> **tdd 修改**:
> - Section 10: 补充所有用户选择
            - Section 4: 补充上下文压缩策略
            - Section 6: 补充网络异常处理
            - Section 8: 补充开发模式相关
            - Section 11: 更新为审核结论
            - 添加成本估算、风险提示、调试工具等章节
            - 更新里程碑时间线
> 
> ### 13.2 鮜期处理
> 
> | 风险点 | 描述 | 缓解措施 |
            |--------|------|----------|
            | 人格漂移 | LLM 长期不稳定 | **人格数值基底**（CommanderProfile 数值字段）+ prompt 锚定；obedience 低按概率判抗命 |
            | 命令确认延迟 | 多条命令逐条往返耗时 | **批量握手**（参谋长批量解析、玩家批量确认）+ 流式输出 + 进度条 |
            | 结算等待 11-15s | 玩家等待体验 | 实时进度 + 流式战报（TTFT<200ms）+ 战区/敌盟真并行 + prompt caching |
            | 回放漂移 | 重复调用 LLM 结果不一致 | sequence 预分配 + LLM 产物只读 log 不重算 + CI event-log 哈希门（详见 §3.1） |
            | LLM 结构化输出不稳定 | JSON 解析失败 | ajv 严格校验 + 规则引擎兜底（不伪造数据）+ M3 解析成功率目标 >95% |
            | persist 被改动绕过 | 刷新/中断丢档 | persist-gate + reducer 守卫双保险 + CI "重启恢复" 硬门 |
> 
> ---
> 
> **审核人**: ai 审核系统
> **批准状态**: 已批准
> **批准日期**: 2026-03-08
# 《赛博战争模拟器》开发计划 V1.0

> 基于：`doc/prd-v1.0.md` + `doc/tech-design-v1.0.md`（审核修订版 v1.0.1）  
> 计划周期：12-16 周（以 13 周为基线，含缓冲）  
> 文档日期：2026-03-08

---

## 1. 计划目标与范围

### 1.1 总体目标
- 在 12-16 周内交付 PRD/TDD 定义的 MVP：
  - WEGO 同步回合制完整闭环
  - 自然语言命令握手（反问+确认）
  - 多 Agent（参谋/司令/统帅/导演部）协同
  - OPFS 持久化（JSON 唯一真相源）
  - ZIP 战役包导入导出闭环

### 1.2 范围边界（MVP 内）
- 单人 vs 敌方 AI
- 盟友外交（不受控盟军）
- 导演部随机事件与最终裁定
- 情报半衰期与残影系统

### 1.3 非目标（V1 不做）
- RTS 实时战斗
- 后端托管用户密钥
- 复杂 3D 地图与复杂物理仿真

---

## 2. 不可违背约束（Hard Constraints）

1. **JSON 为唯一真相源**：`world-state.json` 为唯一权威状态。Markdown 仅审计/上下文辅助。  
2. **导演部拥有最终裁定权**：物理引擎提供参考，导演部可覆写/注入事件。  
3. **命令必须逐条握手确认**：未确认命令不得进入结算。  
4. **仅 OPFS + ZIP**：放弃 GitHub 在线加载。  
5. **每 5 回合上下文压缩**：控制上下文膨胀。  
6. **结算体验优化必做**：11-15s 结算需实时进度 + 流式战报。  
7. **回放基于 event-log**：回放从日志恢复，不重复调用 LLM（避免漂移）。

---

## 3. 里程碑与阶段交付（12-16 周）

## M1（第 1-3 周）项目底座：状态机 + OPFS

### 目标
- 建立可运行的项目骨架与最小闭环（无完整玩法，但可“跑一回合并落盘”）

### 交付项
- [x] 工程基础：前端主应用 + Worker 管线 + 后端转发最小接口（依据：`src/App.tsx`、`src/game/engine/physics-worker.ts`、`server/api-forwarder.ts`；`vite.config.ts` 已按 `server.proxy` 结构配置 `/api` 代理至 `localhost:3001`；`package.json` 新增 `dev:server` 脚本启动后端）
- [x] WEGO 状态机骨架：`idle -> planning -> handshake -> locked -> resolution -> briefing -> persist`（依据：`src/game/state-machine.ts`、`src/game/state-machine.test.ts`）
- [x] OPFS 存储层：
  - [x] 目录初始化（`/saves/{saveId}/...`）（依据：`src/storage/opfs.ts#initializeSaveDirectory`）
  - [x] `world-state.json` 原子写入（tmp + rename）（依据：`src/storage/opfs.ts#atomicWriteFile` + `writeJSONFile`）
  - [x] `turn-snapshot.json` 与 `diagnostics.log`（依据：`src/storage/game-storage.ts#createTurnSnapshot`、`logDiagnostic`）
- [x] 错误处理基线：网络异常暂停回合，状态一致性保障（依据：`src/game/use-game-state.ts` 已接入 `useLLMClient(dispatch)` 并在 `resolution` 阶段调用 `sendRequest`；`src/utils/api-client.ts#fetchLLM` 网络异常触发 `onNetworkError`，由 `src/game/use-llm-client.ts` 映射到 `dispatch({ type: 'PAUSE_GAME' })`，运行时闭环已形成）

### 验收门槛（Exit Criteria）
- [x] 刷新页面后可恢复最近状态（依据：`src/game/use-game-recovery.ts` 并在 `src/App.tsx` 中完成接入）
- [x] 状态机可完整走通 1 个空回合（依据：`src/game/state-machine.test.ts`“完整回合流程”）
- [x] 日志可记录异常与阶段切换（依据：`src/storage/game-storage.ts#logDiagnostic`；`src/game/state-machine.ts` 通过 `history` 记录阶段动作）

---

## M2（第 4-6 周）核心交互：命令握手 + 最小结算 + 沙盘基础

### 目标
- 建立“玩家可下令且可被结算”的最小可玩闭环

### 交付项
- [x] 命令握手协议：
  - [x] 自然语言输入 -> 候选结构化命令（依据：`src/agents/command-parser.ts#parseNaturalLanguageCommand`）
  - [x] 沙盘预演虚线（依据：`src/components/game-board.tsx` 中 `Line` 路径预演层）
  - [x] `[确认执行]` 写入 `pending-orders.json`（依据：`src/storage/game-storage.ts#savePendingOrdersByFaction` + `src/game/use-game-state.ts#saveCurrentGame`）
- [x] 最小物理引擎（Worker）：
  - [x] 基础机动/接敌/损耗计算（依据：`src/game/engine/physics-worker.ts#simulateTurn`）
  - [x] 确定性随机：`scenarioSeed + turnIndex`（依据：`src/game/engine/deterministic-random.ts` + `physics-worker.ts`）
- [x] UI 基础版：
  - [x] 中央网格沙盘（高亮、路径预演）（依据：`src/components/game-board.tsx`）
  - [x] 右侧通信终端（指令确认）（依据：`src/components/command-terminal.tsx`）
  - [x] 底部日志台（事件滚动）（依据：`src/components/event-log-panel.tsx`）

### 验收门槛
- 命令不经确认不可执行
- 固定 seed 回放同输入可复现同结果
- 沙盘交互阶段达到可用帧率目标（接近 60fps）

---

## M3（第 7-10 周）多 Agent 编排：导演部裁定 + 流式战报

### 目标
- 完成多 Agent 协同与导演部主导的回合结算体验

### 交付项
- Agent Action Envelope 协议与执行器
- Agent 编排：
  - 参谋长（玩家侧）
  - 战区司令（并行）
  - 敌/盟统帅（可与司令并行）
  - 导演部（最终裁定）
- 结算 UX：
  - 实时进度条（分 Agent 状态）
  - 流式战报输出
- 回放基线：导演部结果落地 `event-log.jsonl`

### 验收门槛
- 双方锁定后，导演部可产出可回放战报
- 结算阶段可稳定在 11-15s 目标区间
- 回放使用 event-log 数据恢复（非重新请求 LLM）

---

## M4（第 11-13 周，预留到 16 周）玩法补齐：情报/外交/ZIP + 验收

### 目标
- 达成 TDD 验收标准并形成可演示 MVP

### 交付项
- 情报系统：Level 0-3、半衰期、残影时间戳
- 外交系统：盟友请求与不确定履约
- ZIP 战役包：
  - 导入校验（manifest + schema）
  - 导出（存档与差量）
  - 安全解包规则（防 Zip Slip/路径穿越）
- API Key 本地加密：PBKDF2 + AES-GCM（仅会话内解密驻留）
- 开发调试：Agent Inspector（开发模式）

### 验收门槛
- ZIP 导入导出闭环成功
- 情报半衰与残影规则正确生效
- 网络异常时状态一致，不破坏存档

---

## 4. 关键路径（Critical Path）

1. **状态机 + OPFS 真相源（M1）**  
   未完成将阻断所有玩法与回放能力。

2. **命令握手 + 最小结算（M2）**  
   未完成无法形成可玩闭环。

3. **导演部裁定 + event-log 回放（M3）**  
   未完成将导致结果不可解释、不可重放。

4. **ZIP 导入导出 + 验收测试（M4）**  
   未完成无法满足产品形态与交付标准。

---

## 5. 验收标准映射（来自 TDD 7.2）

1. 命令必须“反问+确认”后执行 → **M2**  
2. 锁定后导演部产出可回放战报 → **M3**  
3. 情报半衰期与残影生效 → **M4**  
4. OPFS 静默存档刷新后恢复 → **M1-M2**  
5. ZIP 导入导出闭环成功 → **M4**  
6. 网络异常状态一致性 → **M1-M4（持续）**  
7. 导演部输出写入 event-log，回放不重调 LLM → **M3-M4**

---

## 6. 风险与缓解

### 6.1 高风险
- **人格漂移**：纯 LLM 自由发挥长期不稳定  
  - 缓解：每次 prompt 注入角色锚点；关键决策结构化输出。

- **回放漂移**：重放时二次调用 LLM 导致偏差  
  - 缓解：事件日志为回放输入；状态 checksum 每回合校验。

- **Safari OPFS 清除**：7 天无交互可能清除数据  
  - 缓解：存档后强提醒导出；显著提示 Safari 风险。

### 6.2 中风险
- **11-15s 结算等待体验差**  
  - 缓解：实时进度、流式战报、阶段状态可视化。

- **ZIP 安全风险（路径穿越/Zip Bomb）**  
  - 缓解：严格路径白名单、大小上限、条目数量限制、schema 校验。

---

## 7. 测试与质量计划

### 7.1 测试层次
- 单元测试：命令解析、规则计算、情报衰减、schema 校验
- 集成测试：WEGO 全流程（规划→结算→持久化）
- 回归测试：固定 seed 重放一致性
- E2E：导入战役 -> 3 回合 -> 导出 -> 再导入恢复

### 7.2 每里程碑质量门禁（DoD）
- 关键功能通过对应验收项
- 无阻断级 bug（状态损坏、回放失败、命令越权）
- 日志可审计（diagnostics + event-log）

---

## 8. 团队执行建议（配合本计划）

- 采用“里程碑 + 周迭代”节奏：每周评审关键路径与风险 burn-down。  
- 先做“确定性与可回放”，再追求“叙事质量与 UI 精修”。  
- 按“先底座后体验”顺序推进，避免前期在 UI 过度投入。

---

## 9. 交付物清单（MVP）

- 可运行 Web 客户端（含沙盘、通信、日志、看板基础能力）
- 后端 LLM 转发服务（不存储密钥）
- OPFS 存档与 ZIP 导入导出工具链
- 多 Agent 结算与导演部裁定机制
- 验收测试报告（覆盖 TDD 7.2 全项）

---

## 10. 计划结论

本计划与 PRD/TDD v1.0.1 的审核决策保持一致，遵循“**JSON 真相源、导演部终裁、ZIP-only、12-16 周交付**”主线。按 M1→M4 推进可在第 13 周形成可演示 MVP，并保留至第 16 周的风险缓冲用于稳定性与体验打磨。

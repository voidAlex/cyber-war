# 赛博战争 AI 代理指南


## 项目概述

《赛博战争模拟器》(Cyber War Simulator) 是一款由大语言模型（LLM）驱动的硬核大战略与态势推演游戏。

玩家扮演最高统帅，通过自然语言与 AI 参谋长交互，在战争迷雾中进行盲盒博弈。

## 技术栈
- **运行时**: Node.js 20+ (推荐使用 pnpm)
- **包管理器**: pnpm 8+
- **构建工具**: Vite 5+
- **语言**: TypeScript 5
 **UI框架**: React 19+
- **测试框架**: Vitest 20+
- **存储**: OPFS 持久化（JSON 为唯一真相源）

- **插件化**: ZIP 战役包

支持自定义剧本

## 核心架构
- **前端**：React 应用，运行在浏览器中
  - **沙盘渲染**: 2D 网格地图（高亮、路径预演、热力图）
  - **通信终端**: 自然语言对话界面
  - **左侧看板**: 部队信息、后勤状态
  - **日志台**: 底层事件滚动输出
- **后端**：仅用于 LLM API 转发（无状态存储)
  - **配置**: `tsconfig.json`, `vite.config.ts`
  - **ESLint**: `eslint.config.js`
  - **路径别名**: `@/`、 `@agents/`, `@game/`, `@utils/`, `@types/`

## 构建与 Lint 命令

```bash
# 开发
pnpm dev

# 生产构建
pnpm build
# 预览构建
pnpm preview
# Lint 所有 TS/TSX 文件

pnpm lint
# 运行测试
pnpm test
# 单个测试文件
pnpm test src/utils/format-currency.ts
pnpm test src/game/state-machine.ts --run  # 隔离运行

pnpm test src/agents/command-parser.ts --run  # 隔离运行

```

## 代码风格指南

### Imports 导入规范
- 使用 path aliases (`@/`, `@agents/`, `@game/`, `@utils/`, `@types`)
- **命名导出**:
  - React 组件优先使用 `export default function`
  - 工具函数使用 `export const` 或命名导出
  - 类型定义优先使用 `export type`
  - 放置在 `src/types/` 中
  - 每个文件一个接口/类型
  - 导出 `interface` 作为 barrel 文件
- 保持 barrel 文件小巧且专注
- OPFS API 使用绝对导入，避免深层嵌套

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
- **网络错误**: 暂停当前操作，记录到 `diagnostics.log`，显示用户友好的错误消息
- **API Key 错误**: 显示清晰的消息，引导用户检查有效性
- **LLM 错误**: 使用指数退避重试（最多 3 次，30s 超时）
- **OPFS 错误**: 优雅处理，确保数据完整性
- **验证输入**: 在边界验证所有输入，验证类型，检查必需字段
- **日志记录**: 使用适当的日志级别（error, warn, info, debug）
  - 错误和警告使用 `diagnostics.log`
  - 游戏事件使用 `event-log.jsonl`
  - 开发模式使用 `console`
- **安全**: 永远不要在日志、错误或客户端状态中暴露 API keys
- **清理**: 在记录或处理之前清理所有用户输入、文件路径和数据

## 性能

- **渲染**: 在交互阶段保持 60fps

    - **大型列表**: 对长列表使用虚拟滚动（日志、单位、事件）

    - **OPFS**: 尽可能批量处理文件操作

    - **内存**: 卸载组件时清理大对象


## 浏览器兼容性

- **Chrome 90+**, **Firefox 90+**, **Edge 90+**, **Safari 15.2+**

- **特性检测**: 检测浏览器能力，为不支持的特性提供降级方案


## 文档

- **注释**: 为所有公共接口和复杂逻辑使用 JSDoc

- **README**: 添加新命令或更改模式时更新此文件

- **PRD/TDD**: 参考 `doc/prd-v1.0.md` 和 `doc/tech-design-v1.0.md` 了解架构决策

## 要求

- 给用户回答问题必须使用中文，完成工作后的交付总结也必须用中文
- 用户发出疑问时，必须分析后给用户解决方案的选择，严禁未经确认直接修改文档或代码
- 用户让开始编码前，必须找到当前计划中需要用户澄清的问题，待用户确认后才可开始编码
- 如果用户让排查问题，排查顺序是日志--源码，严禁不通过排查日志和源码直接进行修改，如果缺少问题依据，则需要在关键路径增加日志输出，并告诉用户再次复现；如果是前端无法自行获取日志，则要引导用户告知日志
- 代码必须添加方法级和文件级的中文注释
- 每次对话完后，在结尾加一个“喵~”
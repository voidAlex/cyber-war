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

  - 放置在 `src/types/`

            - 每个文件一个接口/类型

        - 导出 `interface` 作为 barrel 文件

    - 保持 barrel 文件小巧且专注

    - OPFS API 使用绝对导入，避免深层嵌套

        - 使用 `const` 或前缀声明常量值

    - 状态管理使用 PascalCase

 使用 `const [state, useState] = useState<...}`

 ```
        - Avoid magic numbers, state variables
 use `const` for constants that state variables
        - Only declare constants outside of the hook, `useConst` prefix
 for action types, constants
        - State variables, handle in a way that doesn't require external API
     use `useState`, `useEffect`, `useCallback` for side effects
     - Prefer writing custom hooks (e.g., `useEffect(() => { ... }`)
            // Run once on mount
            return () => {
                ...}
            }
 }
        }
    }
        // ... existing code and patterns
        return () => {
            ...}
        }
    }
    // ... existing state from previous render

 // Re-render with new props/dependencies on re-reendering
//           prevDependencies, state && are in the code

 // ... new code should follow existing patterns
        // ... existing state from `useState` is
 `prevState` variable
        const newPrevState = useRef(prevState)
    }, [prevState, ...newState]
 = newPrevState)
 return newPrevState
        })
        // ... other code
        if (state is a 'loading', or 'loading...') state.
            this.setState({ ...newState })
        }
 newPrevState
        })
    } // ... new code
        if (state is 'idle') {
            this.setState({ phase: 'planning', ...newState })
        return
        } else (state.phase !== 'idle' && phase !== 'persist') {
            throw new Error(`Invalid phase transition: ${phase}. Allowed: ${idle}, 'planning', 'handshake', 'locked', 'resolution', 'briefing', 'persist'.`)
            return void
        }
    }
}
```

### TypeScript

- **严格模式**: 始终启用 (`strict: true`)

  - `noUnusedLocals`: true - 捕获未使用的局部变量

  - `noUnusedParameters`: true - 捕获未使用的函数参数（使用 `_` 前缀）

  - `noFallthroughCasesInSwitch`: true - 捕获 switch 穿透

  - `jsx: react-jsx` (需要显式 `react-jsx` 转换)

  - Vite 插件处理 JSX 转换

  - barrel 文件简单时使用 barrel 文件导入

- - 但是，关于 barrel 文件 vs 默认导入（现代 React 代码库不使用 barrel 文件，我们理解组件的工作方式


 keep imports organized at the top of the file, and:
 follow a clear and hierarchy.    - Barrel imports from parent directories go at the top
 file first
 then alias them for logical clarity and understanding the. relationships.
  - - All imports from a single file should go at the first (e.g., `@game/engine/physics-worker.ts`)
        - use path aliases (`@/`, `@agents/`, `@game/`, `@utils/`) to utility files,        - Use PascalCase for state management (e.g., `useState` hook)
            return an the state
        }

 if (action.type === 'function') {
                const prevPhase = gameState.phase
                switch (phase) {
                    case 'handshake':
                        // Command needs confirmation before handshake
                        const newCandidateCommand = {
                            ...payload,
                            confidence,
                            requiresConfirmation
                        }
                    }
                    case 'locked':
                        // Both faction's orders are locked, no commands can be executed
                    this.setState({ phase: 'resolution', ...newState })
                    case 'briefing':
                        // Show battle progress
                        const newReport = reportStream to the
                        this.setState({ phase: 'persist', ...newState })
                        return newPrevState
                    })
                    // ... new state
                    // ... existing patterns (for state management)
                    // ... existing code
        const [state, setCurrentState] = `updateGameState` takes a state and returns it
 - Use `const` prefix for constant values
        - Add the/state management logic (e.g., `setCount`)
`).
    }
  }
            // Update UI
 states (e.g., battle progress, victory conditions)
            // ... existing code patterns (like state management with `useState`)
        // ... new code should follow existing patterns
        - ... existing codebase patterns strictly
    -  - Avoid magic numbers in state variables
        - Use `const` for constants at the top of files
            // Use `const` for action types
            const ACTION_TYPE = 'move' | 'attack_node' | 'capture_node' | { ...payload, confidence, requiresConfirmation }
            }
        } | ACTION | AgentAction {
        ...payload,
        confidence,
            requiresConfirmation
            "action_id": string
            "intent": string
            // Action description (e.g., "capture_node")
            "payload": { node: "C3", units: ["arm-1"] } // Array of unit IDs
            "confidence": 0.78
            "requiresConfirmation": false
        }
    }
}
```

- **命名约定**

    - **组件**:** PascalCase，文件名（如 `GameState.tsx`, `UnitCard.tsx`）

        - **工具函数**:** `format-currency.ts`, `utils/format-date.ts`

        - `logger.ts` 用于日志

    - **类型**:** 使用 interface/type 定义；优先直接 `.d.ts` 文件导入。避免 `import * from a library`。使用 `import type { ... } from 'library'` 而不是 `import { Component } from 'react'`        - `import { useState, useEffect } from 'react'`

        - `import { GameState, Faction, Unit, GameMap, MapCell } from '../types'

        // Type definitions
        export type GameState = {
            turn: number
            phase: 'idle' | 'planning' | 'handshake' | 'locked' | 'resolution' | 'briefing' | 'persist'
            worldState: WorldState
        }
        export interface WorldState {
            turnIndex: number
            scenarioSeed: string
            factions: Faction[]
            units: Unit[]
            map: GameMap
        }
        export interface Faction {
            id: string
            name: string
            type: 'player' | 'enemy' | 'ally'
            trust: number // 0-100, for allies
        }
        export interface Unit {
            id: string
            name: string
            factionId: string
            position: { x: number; y: number }
            hp: number
            maxHp: number
        }
        export interface GameMap {
            width: number
            height: number
            cells: MapCell[][]
        }
        export interface MapCell {
            x: number
            y: number
            terrain: 'plain' | 'mountain' | 'water' | 'urban' | 'forest'
            fogLevel: 0 | 1 | 2 | 3
        }
        export interface AgentAction {
            turn: number
            faction: string
            agentId: string
            intent: string
            payload: Record<string, unknown>
            confidence: number
            requiresConfirmation: boolean
        }
        // ... other types
        export type {
            GameState,
            WorldState,
            Faction,
            Unit,
            GameMap,
            MapCell,
            AgentAction,
        }
        ```
    }
        ```

    **错误处理**

    - **网络错误**: 暂停当前操作，记录到 `diagnostics.log`，显示用户友好的错误消息

    - **API Key 错误**: 显示清晰的消息，引导用户检查有效性

    - **LLM 错误**: 使用指数退避重试（最多 3 次，30s 超时）

    - **OPFS 错误**: 优雅处理，确保数据完整性

    - **使用类型化错误结果** 尽可能

    - 为 UI 提供有意义的错误消息

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


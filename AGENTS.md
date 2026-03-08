# Cyber-war AG AI Agent Guide

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

## Build & Lint Commands
```bash
# 开发
pnpm dev

# 生产构建
pnpm build
# 预览构建
pnpm preview
# Lint all TS/ TSX files
pnpm lint
# 运行测试
pnpm test
# 单个测试文件
pnpm test src/utils/format-currency.ts
pnpm test src/game/state-machine.ts --run in isolation
pnpm test src/agents/command-parser.ts --run in isolation
```

## 代码风格指南
### Imports
- 使用 path aliases (`@/`, `@agents/`, `@game/`, `@utils/`, `@types`)
- **Named exports**:**
  - Prefer `export default function` for React components
  - Use `export const` or named exports for utility functions
  - Prefer `export type` for type definitions
  - Place in `src/types/`
            - Only one interface/type per file
        - Export an `interface` as a barrel file
    - Keep barrel files small and focused
    - Use absolute imports for OPFS API, avoid deep nesting
        - Use `const` or prefix for constants that state values
    - Use PascalCase for state management
 use `const [state, useState] = useState<...}`
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
- **Strict mode**: Always enabled (`strict: true`)
  - `noUnusedLocals`: true - catches unused local variables
  - `noUnusedParameters`: true - catches unused function parameters (prefix with `_)
  - `noFallthroughCasesInSwitch`: true - catches fallthrough cases in switch statements
  - `jsx: react-jsx` (explicit `react-jsx` transform) is needed)
  - Vite plugin handles JSX transformation
  - use barrel file imports when the barrel file is simple
- - However, we about barrel files vs. default imports (no barrel file for modern React codebase, we understand what components work.

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

- **Naming conventions**
    - **Components**:** PascalCase, file name (e.g., `GameState.tsx`, `UnitCard.tsx`)
        - **utils**:** `format-currency.ts`, `utils/format-date.ts`
        - `logger.ts` for logging
    - **types**:** Use interface/type definitions; prefer direct `.d.ts` file imports. Avoid `import * from a library. Use `import type { ... } from 'library'` instead of `import { Component } from 'react'`        - `import { useState, useEffect } from 'react'`
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

    **Error handling**
    - **Network errors**: Pause current operation, log to `diagnostics.log`, show user-friendly error message
    - **API key errors**: Display clear message, guide user to check validity
    - **LLM errors**: Retry with exponential backoff (max 3 retries, 30s timeout)
    - **OPFS errors**: Handle gracefully, ensure data integrity
    - **Use typed error results** when possible
    - Provide meaningful error messages for UI
    - **Validate inputs**: Validate all inputs at boundaries, validate types, check required fields
    - **Logging**: Use appropriate logging levels (error, warn, info, debug)
    - **Use `diagnostics.log` for errors and warnings
    - **Use `event-log.jsonl` for game events
    - **Use `console` in development mode

    - **Security**: Never expose API keys in logs, errors, or client-side state
    - **Sanitize**: Sanitize all user inputs, file paths, and data before logging or processing

## Performance
- **Rendering**: Maintain 60fps during interaction phase
    - **Large lists**: Use virtual scrolling for long lists (logs, units, events)
    - **OPFS**: Batch file operations where possible
    - **Memory**: Clean up large objects when unmounting components

## Browser Compatibility
- **Chrome 90+**, **Firefox 90+**, **Edge 90+**, **Safari 15.2+**
- **Feature detection**: Detect browser capabilities, provide fallbacks for unsupported features

## Documentation
- **Comments**: Use JSDoc for all public interfaces, complex logic
- **README**: Update this file when adding new commands or changing patterns
- **PRD/TDD**: Reference `doc/prd-v1.0.md` and `doc/tech-design-v1.0.md` for architecture decisions

import { createContext } from 'react'
import type { UseGameStateReturn } from './use-game-state'

export const GameStateStore = createContext<UseGameStateReturn | null>(null)

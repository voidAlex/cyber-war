import { useContext } from 'react'
import type { UseGameStateReturn } from './use-game-state'
import { GameStateStore } from './game-state-store'

export function useGameStateContext(): UseGameStateReturn {
  const context = useContext(GameStateStore)
  if (!context) {
    throw new Error('useGameStateContext must be used within GameStateProvider')
  }
  return context
}

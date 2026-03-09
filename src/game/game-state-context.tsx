import { type ReactNode } from 'react'
import { useGameState } from './use-game-state'
import { GameStateStore } from './game-state-store'

export function GameStateProvider({ children }: { children: ReactNode }) {
  const gameState = useGameState()
  return <GameStateStore.Provider value={gameState}>{children}</GameStateStore.Provider>
}

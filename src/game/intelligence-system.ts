import type { WorldState, MapCell } from '@/types'

const HOUR_MS = 60 * 60 * 1000

export const INTELLIGENCE_HALF_LIFE_HOURS = 24

export const INTELLIGENCE_GHOST_RETENTION_HOURS = 72

export function applyIntelligenceDecay(worldState: WorldState, nowMs: number = Date.now()): WorldState {
  const nextCells = worldState.map.cells.map(row => row.map(cell => applyCellIntelligenceDecay(cell, nowMs)))

  return {
    ...worldState,
    map: {
      ...worldState.map,
      cells: nextCells,
    },
  }
}

export function getGhostTimestampLabel(intelligenceTimestamp: number, nowMs: number = Date.now()): string {
  const elapsedHours = Math.max(0, Math.floor((nowMs - intelligenceTimestamp) / HOUR_MS))
  return `T-${elapsedHours}h`
}

function applyCellIntelligenceDecay(cell: MapCell, nowMs: number): MapCell {
  if (!cell.intelligenceTimestamp) {
    return {
      ...cell,
      fogLevel: 3,
      ghostUnitId: undefined,
      ghostTimestamp: undefined,
    }
  }

  const elapsedHours = (nowMs - cell.intelligenceTimestamp) / HOUR_MS

  if (elapsedHours <= INTELLIGENCE_HALF_LIFE_HOURS) {
    return {
      ...cell,
      fogLevel: 1,
    }
  }

  if (elapsedHours <= INTELLIGENCE_HALF_LIFE_HOURS * 2) {
    return {
      ...cell,
      fogLevel: 2,
      ghostUnitId: cell.ghostUnitId,
      ghostTimestamp: cell.ghostTimestamp,
    }
  }

  if (elapsedHours <= INTELLIGENCE_GHOST_RETENTION_HOURS) {
    const ghostUnitId = cell.ghostUnitId ?? cell.unitId
    return {
      ...cell,
      fogLevel: 2,
      unitId: undefined,
      ghostUnitId,
      ghostTimestamp: cell.intelligenceTimestamp,
    }
  }

  return {
    ...cell,
    fogLevel: 3,
    unitId: undefined,
    ghostUnitId: undefined,
    ghostTimestamp: undefined,
  }
}

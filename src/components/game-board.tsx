import { Stage, Layer, Rect, Line, Circle, Text } from 'react-konva'
import { useMemo, useState } from 'react'
import { useGameStateContext } from '@/game'

const CELL_SIZE = 40

function nodeLabel(x: number, y: number): string {
  return `${String.fromCharCode(65 + y)}${x + 1}`
}

function parseNode(node: string): { x: number; y: number } | null {
  if (!node || node.length < 2) {
    return null
  }
  const upper = node.toUpperCase()
  const y = upper.charCodeAt(0) - 65
  const x = Number(upper.slice(1)) - 1
  if (Number.isNaN(x) || x < 0 || y < 0) {
    return null
  }
  return { x, y }
}

export function GameBoard() {
  const { gameState, context } = useGameStateContext()
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null)

  const map = gameState?.worldState.map
  const width = (map?.width ?? 10) * CELL_SIZE
  const height = (map?.height ?? 10) * CELL_SIZE

  const previewPath = useMemo(() => {
    const firstPending = context.pendingOrders[0]
    const node = firstPending?.payload?.node
    if (!node) {
      return null
    }
    return parseNode(String(node))
  }, [context.pendingOrders])

  if (!map) {
    return <div className="panel-fallback">尚未加载地图</div>
  }

  return (
    <div className="game-board-panel">
      <h3>态势沙盘</h3>
      <Stage width={width} height={height} className="game-board-stage">
        <Layer>
          {Array.from({ length: map.height }).map((_, row) =>
            Array.from({ length: map.width }).map((__, col) => {
              const cell = map.cells[row]?.[col]
              const fog = cell?.fogLevel ?? 3
              const fill = fog >= 3 ? '#1a1f2a' : fog === 2 ? '#223046' : '#2f4b6f'
              const isHover = hoverCell?.x === col && hoverCell?.y === row

              return (
                <Rect
                  key={`${col}-${row}`}
                  x={col * CELL_SIZE}
                  y={row * CELL_SIZE}
                  width={CELL_SIZE}
                  height={CELL_SIZE}
                  fill={fill}
                  stroke={isHover ? '#ffd166' : '#3f4c66'}
                  strokeWidth={isHover ? 2 : 1}
                  onMouseEnter={() => setHoverCell({ x: col, y: row })}
                  onMouseLeave={() => setHoverCell(null)}
                />
              )
            })
          )}
        </Layer>

        <Layer>
          {previewPath && (
            <>
              <Line
                points={[
                  CELL_SIZE / 2,
                  CELL_SIZE / 2,
                  previewPath.x * CELL_SIZE + CELL_SIZE / 2,
                  previewPath.y * CELL_SIZE + CELL_SIZE / 2,
                ]}
                stroke="#2dd4bf"
                strokeWidth={3}
                dash={[8, 6]}
              />
              <Circle
                x={previewPath.x * CELL_SIZE + CELL_SIZE / 2}
                y={previewPath.y * CELL_SIZE + CELL_SIZE / 2}
                radius={8}
                fill="#2dd4bf"
              />
            </>
          )}
        </Layer>

        <Layer>
          {hoverCell && (
            <Text
              x={hoverCell.x * CELL_SIZE + 4}
              y={hoverCell.y * CELL_SIZE + 4}
              text={nodeLabel(hoverCell.x, hoverCell.y)}
              fill="#e5e7eb"
              fontSize={12}
            />
          )}
        </Layer>
      </Stage>
    </div>
  )
}

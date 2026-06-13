/**
 * 沙盘坐标系统（coords.ts）— 纯函数，无 PixiJS 依赖。
 *
 * 坐标语义统一（与 types/map.ts、types/unit.ts 对齐）：
 * - 列 col = x（字母 A/B/C...，A=0）
 * - 行 row = y（数字 1/2/3...，1=0 的数组下标，但显示用 1 起步）
 *
 * 沙盘坐标系（PIXI stage）原点在左上角：
 * - cell (0,0) 的像素左上角 = (0,0)
 * - cell (col,row) 的中心 = (cellToPixel 中心坐标)
 *
 * 这里的纯函数不依赖 PIXI，便于 vitest 单测（渲染逻辑本身不测）。
 *
 * @module layers/ui/sandbox/coords
 */

/** 单元像素尺寸（边长），用于网格绘制与坐标映射。 */
export const CELL_SIZE = 48

/** 网格线宽度（像素）。 */
export const GRID_LINE_WIDTH = 1

/** 列字母表起始：'A' = 65。0 → A，1 → B，25 → Z，26 → AA。 */
const LETTER_A = 'A'.charCodeAt(0)

/**
 * 列号（0 起步）转列字母（如 0→A、1→B、27→AB），支持 26 列以上。
 *
 * 与电子表格列名规则一致（非简单 mod 26），便于大地图扩展。
 */
export function colToLetter(col: number): string {
  if (!Number.isInteger(col) || col < 0) {
    throw new RangeError(`col 必须 >=0 的整数，收到 ${col}`)
  }
  let n = col
  let s = ''
  do {
    const rem = n % 26
    s = String.fromCharCode(LETTER_A + rem) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/**
 * 列字母转列号（0 起步），与 colToLetter 互逆。
 *
 * 接受大小写；非法字符抛 RangeError。
 */
export function letterToCol(letter: string): number {
  const upper = letter.toUpperCase()
  if (!/^[A-Z]+$/.test(upper)) {
    throw new RangeError(`列字母非法：${letter}`)
  }
  let col = 0
  for (let i = 0; i < upper.length; i++) {
    col = col * 26 + (upper.charCodeAt(i) - LETTER_A) + 1
  }
  return col - 1
}

/**
 * cellId 生成（与 cell.id 的约定一致）：列字母 + 行号(1 起步)，如 (2,2)→"C3"。
 *
 * 这是渲染层坐标标签与 cellId 的通用格式，供 onCellClick 回调使用。
 */
export function cellIdFromCoord(col: number, row: number): string {
  return `${colToLetter(col)}${row + 1}`
}

/**
 * cellId（如 "C3"）解析回 {col,row}（0 起步）。
 *
 * 解析失败抛 RangeError；M2 渲染层在批量读取 cell.id 时容错调用。
 */
export function coordFromCellId(cellId: string): { col: number; row: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(cellId)
  if (m === null || m[1] === undefined || m[2] === undefined) {
    throw new RangeError(`cellId 格式非法：${cellId}`)
  }
  return {
    col: letterToCol(m[1]),
    row: Number(m[2]) - 1,
  }
}

/**
 * 网格坐标 → cell 左上角像素坐标。
 *
 * 用于绘制网格矩形、网格线端点。cell (0,0) 左上角 = (0,0)。
 */
export function cellToPixel(col: number, row: number): { x: number; y: number } {
  return { x: col * CELL_SIZE, y: row * CELL_SIZE }
}

/**
 * 网格坐标 → cell 中心像素坐标。
 *
 * 用于绘制单位军标、虚线预演端点、高亮居中标记。
 */
export function cellCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * CELL_SIZE + CELL_SIZE / 2,
    y: row * CELL_SIZE + CELL_SIZE / 2,
  }
}

/**
 * 整张网格的像素宽高（不含边距）。
 */
export function gridPixelSize(cols: number, rows: number): { width: number; height: number } {
  return { width: cols * CELL_SIZE, height: rows * CELL_SIZE }
}

/**
 * 像素坐标 → 网格坐标（用于鼠标点击/悬停命中判定）。
 *
 * 落在网格线右/下边界外（>= cols/rows）返回 null。负值返回 null。
 */
export function pixelToCell(
  x: number,
  y: number,
  cols: number,
  rows: number,
): { col: number; row: number } | null {
  if (x < 0 || y < 0) return null
  const col = Math.floor(x / CELL_SIZE)
  const row = Math.floor(y / CELL_SIZE)
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null
  return { col, row }
}

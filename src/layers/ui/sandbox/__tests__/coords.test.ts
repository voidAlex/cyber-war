/**
 * 沙盘坐标纯函数测试（coords.test.ts）— vitest。
 *
 * 只测纯函数（坐标映射/字母互转/cellId 解析/像素命中），不测 PixiJS 渲染
 * （渲染需 WebGL/DOM，单测环境跑不起来，由 build + 手动验证覆盖）。
 *
 * @module layers/ui/sandbox/__tests__/coords
 */

import { describe, it, expect } from 'vitest'
import {
  CELL_SIZE,
  cellCenter,
  cellIdFromCoord,
  cellToPixel,
  colToLetter,
  coordFromCellId,
  gridPixelSize,
  letterToCol,
  pixelToCell,
} from '../coords'

describe('CELL_SIZE', () => {
  it('为正整数（48px 默认）', () => {
    expect(CELL_SIZE).toBeGreaterThan(0)
    expect(Number.isInteger(CELL_SIZE)).toBe(true)
  })
})

describe('colToLetter / letterToCol', () => {
  it('0→A，1→B，25→Z（单字母）', () => {
    expect(colToLetter(0)).toBe('A')
    expect(colToLetter(1)).toBe('B')
    expect(colToLetter(25)).toBe('Z')
  })

  it('26→AA，27→AB（多字母，电子表格规则）', () => {
    expect(colToLetter(26)).toBe('AA')
    expect(colToLetter(27)).toBe('AB')
    expect(colToLetter(51)).toBe('AZ')
    expect(colToLetter(52)).toBe('BA')
  })

  it('letterToCol 是 colToLetter 的逆函数', () => {
    for (const c of [0, 1, 25, 26, 27, 51, 52, 100, 701, 702]) {
      expect(letterToCol(colToLetter(c))).toBe(c)
    }
  })

  it('接受大小写', () => {
    expect(letterToCol('a')).toBe(0)
    expect(letterToCol('z')).toBe(25)
    expect(letterToCol('aa')).toBe(26)
  })

  it('非法输入抛 RangeError', () => {
    expect(() => letterToCol('A1')).toThrow(RangeError)
    expect(() => letterToCol('')).toThrow(RangeError)
    expect(() => letterToCol('AB!')).toThrow(RangeError)
    expect(() => colToLetter(-1)).toThrow(RangeError)
    expect(() => colToLetter(1.5)).toThrow(RangeError)
  })
})

describe('cellIdFromCoord / coordFromCellId', () => {
  it('(0,0)→A1，(2,2)→C3', () => {
    expect(cellIdFromCoord(0, 0)).toBe('A1')
    expect(cellIdFromCoord(2, 2)).toBe('C3')
    expect(cellIdFromCoord(0, 9)).toBe('A10')
  })

  it('coordFromCellId 互逆', () => {
    expect(coordFromCellId('A1')).toEqual({ col: 0, row: 0 })
    expect(coordFromCellId('C3')).toEqual({ col: 2, row: 2 })
    expect(coordFromCellId('A10')).toEqual({ col: 0, row: 9 })
    expect(coordFromCellId('AA5')).toEqual({ col: 26, row: 4 })
  })

  it('非法 cellId 抛 RangeError', () => {
    expect(() => coordFromCellId('3C')).toThrow(RangeError)
    expect(() => coordFromCellId('')).toThrow(RangeError)
    expect(() => coordFromCellId('ABC')).toThrow(RangeError)
  })
})

describe('cellToPixel / cellCenter', () => {
  it('cellToPixel 返回左上角，cell (0,0) 为原点', () => {
    expect(cellToPixel(0, 0)).toEqual({ x: 0, y: 0 })
    expect(cellToPixel(2, 3)).toEqual({ x: 2 * CELL_SIZE, y: 3 * CELL_SIZE })
  })

  it('cellCenter 返回中心（左上角 + CELL_SIZE/2）', () => {
    const tl = cellToPixel(2, 3)
    const c = cellCenter(2, 3)
    expect(c.x).toBe(tl.x + CELL_SIZE / 2)
    expect(c.y).toBe(tl.y + CELL_SIZE / 2)
    // (0,0) 中心 = CELL_SIZE/2
    expect(cellCenter(0, 0)).toEqual({ x: CELL_SIZE / 2, y: CELL_SIZE / 2 })
  })
})

describe('gridPixelSize', () => {
  it('宽=cols*CELL_SIZE，高=rows*CELL_SIZE', () => {
    expect(gridPixelSize(5, 4)).toEqual({ width: 5 * CELL_SIZE, height: 4 * CELL_SIZE })
  })

  it('0×0 网格返回 0×0', () => {
    expect(gridPixelSize(0, 0)).toEqual({ width: 0, height: 0 })
  })
})

describe('pixelToCell（鼠标命中判定）', () => {
  it('命中 cell 左上角', () => {
    expect(pixelToCell(0, 0, 5, 5)).toEqual({ col: 0, row: 0 })
  })

  it('命中 cell 内部任意点（同 cell）', () => {
    const c = pixelToCell(CELL_SIZE + 10, CELL_SIZE * 2 + 20, 5, 5)
    expect(c).toEqual({ col: 1, row: 2 })
  })

  it('落在边界外（>= cols/rows）返回 null', () => {
    expect(pixelToCell(5 * CELL_SIZE, 0, 5, 5)).toBeNull()
    expect(pixelToCell(0, 5 * CELL_SIZE, 5, 5)).toBeNull()
  })

  it('负坐标返回 null', () => {
    expect(pixelToCell(-1, 0, 5, 5)).toBeNull()
    expect(pixelToCell(0, -1, 5, 5)).toBeNull()
  })

  it('恰好在最后 cell 边界内（cols-1）命中', () => {
    const c = pixelToCell(4 * CELL_SIZE + CELL_SIZE - 1, 4 * CELL_SIZE + CELL_SIZE - 1, 5, 5)
    expect(c).toEqual({ col: 4, row: 4 })
  })
})

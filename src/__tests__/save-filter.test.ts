/**
 * 存档列表过滤测试（save-filter.test.ts）— 纯逻辑。
 *
 * 验证（M3 范围#2）：listSaves 返回时过滤掉伪 saveId `__runtime_llm_config__`
 * （runtime-config 占用，不应出现在玩家存档列表）。
 *
 * 过滤谓词导出为纯函数以便单测（store 内多处复用同一常量）。
 *
 * @module __tests__/save-filter
 */

import { describe, it, expect } from 'vitest'
import { isPlayerSaveId } from '@/store/save-filter'

describe('isPlayerSaveId — 伪 saveId 过滤', () => {
  it('过滤掉 __runtime_llm_config__（runtime-config 占用）', () => {
    expect(isPlayerSaveId('__runtime_llm_config__')).toBe(false)
  })

  it('正常存档 id 通过', () => {
    expect(isPlayerSaveId('verdun-1916')).toBe(true)
    expect(isPlayerSaveId('save-001')).toBe(true)
  })

  it('列表整体过滤（store.refreshSaves 内复用此谓词）', () => {
    const raw = ['verdun-1916', '__runtime_llm_config__', 'save-002', '__runtime_llm_config__']
    const filtered = raw.filter(isPlayerSaveId)
    expect(filtered).toEqual(['verdun-1916', 'save-002'])
  })
})

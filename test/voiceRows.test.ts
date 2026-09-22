import { describe, expect, it } from 'vitest'
import { countIgnored, isFavorRow, pickPayable, type VoiceRowLike } from '../web/src/voiceRows.ts'

function row(patch: Partial<VoiceRowLike> = {}): VoiceRowLike {
  return { status: 'ok', direction: 'expense', favor_contact: '', favor_kind: '', ...patch }
}

describe('voice 入账行筛选', () => {
  it('明细场景：解析成功且方向不是忽略的行都能入账', () => {
    const rows = [
      row(),
      row({ direction: 'income' }),
      row({ status: 'error' }),
      row({ direction: 'skip' }),
      row({ status: 'skip' }),
    ]
    expect(pickPayable(rows, 'tx')).toHaveLength(2)
  })

  it('人情场景：只留识别人情的行，流水行被忽略', () => {
    const rows = [
      row({ favor_contact: '张三', favor_kind: 'give' }),
      row(),
      row({ favor_contact: '李四', favor_kind: 'receive' }),
      row({ favor_contact: '王五', favor_kind: '' }),
    ]
    expect(pickPayable(rows, 'favor')).toHaveLength(2)
    // 普通流水行，以及有姓名但没识别人情方向的行，都不算人情
    expect(countIgnored(rows)).toBe(2)
  })

  it('人情场景：解析失败或被标记忽略的人情行不入账', () => {
    const rows = [
      row({ favor_contact: '张三', favor_kind: 'give', status: 'error' }),
      row({ favor_contact: '张三', favor_kind: 'give', direction: 'skip' }),
    ]
    expect(pickPayable(rows, 'favor')).toEqual([])
    expect(countIgnored(rows)).toBe(0)
  })

  it('只有姓名没有方向时不算人情', () => {
    expect(isFavorRow(row({ favor_contact: '张三' }))).toBe(false)
    expect(isFavorRow(row({ favor_kind: 'give' }))).toBe(false)
    expect(isFavorRow(row({ favor_contact: '张三', favor_kind: 'give' }))).toBe(true)
  })
})

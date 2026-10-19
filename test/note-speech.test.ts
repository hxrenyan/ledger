import { describe, expect, it } from 'vitest'
import { parseSpokenNotes } from '../src/calendar/noteSpeech.ts'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

/** 2026-10-19 是周一，上海中午。 */
const NOW = Date.UTC(2026, 9, 19, 4, 0, 0)

function notes(text: string) {
  return parseSpokenNotes(text, NOW)
}

describe('日历语音拆日期和事情', () => {
  it('没说日期就记在今天，事情保留原话', () => {
    expect(notes('买菜')).toEqual([{ day: '2026-10-19', body: '买菜', clipped: false }])
    expect(notes('还有事')).toEqual([{ day: '2026-10-19', body: '还有事', clipped: false }])
  })

  it('相对日和事情分开', () => {
    expect(notes('明天下午三点开会')).toEqual([{ day: '2026-10-20', body: '下午三点开会', clipped: false }])
    expect(notes('记得明天下午三点开会')).toEqual([{ day: '2026-10-20', body: '下午三点开会', clipped: false }])
    expect(notes('帮我记一下，明天开会')).toEqual([{ day: '2026-10-20', body: '开会', clipped: false }])
    expect(notes('大后天交报告')).toEqual([{ day: '2026-10-22', body: '交报告', clipped: false }])
    expect(notes('前天补卡')).toEqual([{ day: '2026-10-17', body: '补卡', clipped: false }])
  })

  it('一句里多件事按日期切开', () => {
    expect(notes('明天开会，后天去医院')).toEqual([
      { day: '2026-10-20', body: '开会', clipped: false },
      { day: '2026-10-21', body: '去医院', clipped: false },
    ])
    expect(notes('买菜，明天开会')).toEqual([
      { day: '2026-10-19', body: '买菜', clipped: false },
      { day: '2026-10-20', body: '开会', clipped: false },
    ])
  })

  it('星期、几月几号和月底按阳历落到对应那天', () => {
    expect(notes('周五开会')).toEqual([{ day: '2026-10-23', body: '开会', clipped: false }])
    expect(notes('下周一交周报')).toEqual([{ day: '2026-10-26', body: '交周报', clipped: false }])
    expect(notes('上周三复盘')).toEqual([{ day: '2026-10-14', body: '复盘', clipped: false }])
    expect(notes('周末看电影')).toEqual([{ day: '2026-10-24', body: '看电影', clipped: false }])
    expect(notes('这周日家庭日')).toEqual([{ day: '2026-10-25', body: '家庭日', clipped: false }])
    expect(notes('10月20日下午三点在公司开会')).toEqual([
      { day: '2026-10-20', body: '下午三点在公司开会', clipped: false },
    ])
    expect(notes('十月二十号聚餐')).toEqual([{ day: '2026-10-20', body: '聚餐', clipped: false }])
    expect(notes('10月1日休息')).toEqual([{ day: '2027-10-01', body: '休息', clipped: false }])
    expect(notes('2026年10月1日国庆')).toEqual([{ day: '2026-10-01', body: '国庆', clipped: false }])
    expect(notes('20号体检')).toEqual([{ day: '2026-10-20', body: '体检', clipped: false }])
    expect(notes('15号缴费')).toEqual([{ day: '2026-11-15', body: '缴费', clipped: false }])
    expect(notes('下个月3号还房贷')).toEqual([{ day: '2026-11-03', body: '还房贷', clipped: false }])
    expect(notes('这个月1号复盘')).toEqual([{ day: '2026-10-01', body: '复盘', clipped: false }])
    expect(notes('月底提交')).toEqual([{ day: '2026-10-31', body: '提交', clipped: false }])
    expect(notes('下个月底对账')).toEqual([{ day: '2026-11-30', body: '对账', clipped: false }])
  })

  it('语音转写的日期写法也能落到对应那天', () => {
    expect(notes('下个周一交周报')).toEqual([{ day: '2026-10-26', body: '交周报', clipped: false }])
    expect(notes('周5开会')).toEqual([{ day: '2026-10-23', body: '开会', clipped: false }])
    expect(notes('下周1交周报')).toEqual([{ day: '2026-10-26', body: '交周报', clipped: false }])
    expect(notes('10月20开会')).toEqual([{ day: '2026-10-20', body: '开会', clipped: false }])
    expect(notes('十月二十去医院')).toEqual([{ day: '2026-10-20', body: '去医院', clipped: false }])
    expect(notes('20好体检')).toEqual([{ day: '2026-10-20', body: '体检', clipped: false }])
    expect(notes('2026-10-01国庆')).toEqual([{ day: '2026-10-01', body: '国庆', clipped: false }])
    expect(notes('二五年十月二十号聚餐')).toEqual([{ day: '2025-10-20', body: '聚餐', clipped: false }])
    expect(notes('26年10月20日开会')).toEqual([{ day: '2026-10-20', body: '开会', clipped: false }])
    expect(notes('明儿开会')).toEqual([{ day: '2026-10-20', body: '开会', clipped: false }])
    expect(notes('3号线地铁')).toEqual([{ day: '2026-10-19', body: '3号线地铁', clipped: false }])
  })

  it('只听到日期时留下空事情，不把日期本身当成正文', () => {
    expect(notes('明天')).toEqual([{ day: '2026-10-20', body: '', clipped: false }])
  })

  it('非法日期和农历不误拆，整句留在今天', () => {
    expect(notes('2月31日开会')).toEqual([{ day: '2026-10-19', body: '2月31日开会', clipped: false }])
    expect(notes('农历八月十五回家')).toEqual([{ day: '2026-10-19', body: '农历八月十五回家', clipped: false }])
  })

  it('正文超过 200 字会截断', () => {
    const body = '开'.repeat(201)
    const [item] = notes(`明天${body}`)
    expect(item?.day).toBe('2026-10-20')
    expect(item?.clipped).toBe(true)
    expect([...(item?.body ?? '')].length).toBe(200)
  })
})

describe('日历语音解析接口', () => {
  it('只返回拆分结果，不写入记事', async () => {
    const db = createSqliteDb(':memory:')
    await ensureMigrated(db)
    const app = createApp({ db, jwtSecret: 'test-secret-test-secret', adminToken: 'admin-secret' })
    const registered = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'notespeech', password: 'password1' }),
    })
    const session = (await registered.json()) as { token: string; ledgers: { id: number }[] }
    const headers = {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      'x-ledger-id': String(session.ledgers[0]?.id),
    }
    const parsed = await app.request('/api/v1/day-notes/parse', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '明天下午三点开会' }),
    })
    expect(parsed.status).toBe(200)
    const body = (await parsed.json()) as { items: { day: string; body: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.body).toBe('下午三点开会')
    const listed = await app.request('/api/v1/day-notes?month=2026-10', { headers })
    const month = (await listed.json()) as { items: unknown[] }
    expect(month.items).toEqual([])
    const blank = await app.request('/api/v1/day-notes/parse', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '   ' }),
    })
    expect(blank.status).toBe(400)
  })
})

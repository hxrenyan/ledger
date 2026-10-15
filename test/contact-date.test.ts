import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { buildReminder, parseContactDate, type Ymd } from '../src/calendar/contactDate.ts'
import { listDictItems, ensureDictItem } from '../src/dicts.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { issueHandoff, redeemHandoff } from '../src/auth/handoff.ts'
import { addDays, shanghaiDate } from '../src/time.ts'

const today: Ymd = { y: 2026, m: 10, d: 15 }

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({ db, jwtSecret: 'test-secret-test-secret', adminToken: 'admin-secret' })
  return { app, db }
}

async function json(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  const res = await app.request(path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body }
}

describe('联系人日子', () => {
  it('未来 30 天显示还剩几天，并按出生日算出岁数', () => {
    const date = parseContactDate(
      { kind: 'birthday', calendar: 'solar', month: 10, day: 18, year: 2000 },
      today,
    )
    expect(buildReminder(date, today)).toEqual({
      state: 'upcoming',
      days: 3,
      text: '还剩 3 天',
      age_text: '25岁11个月27天',
    })
  })

  it('已经过去的显示过了几天；当天是今天', () => {
    const passed = parseContactDate(
      { kind: 'birthday', calendar: 'solar', month: 10, day: 10, year: 2000 },
      today,
    )
    expect(buildReminder(passed, today)).toEqual({
      state: 'past',
      days: 5,
      text: '过了 5 天',
      age_text: '26岁0个月5天',
    })
    const onDay = parseContactDate(
      { kind: 'anniversary', calendar: 'solar', month: 10, day: 15, year: 2020 },
      today,
    )
    expect(buildReminder(onDay, today)?.text).toBe('今天')
    expect(buildReminder(onDay, today)?.age_text).toBe('6年0个月0天')
  })

  it('没填年份不算年龄；农历正月初一能对上阳历', () => {
    const bare = parseContactDate({ kind: 'birthday', calendar: 'solar', month: 10, day: 18 }, today)
    expect(buildReminder(bare, today)?.age_text).toBe('')
    const lunarToday: Ymd = { y: 2020, m: 1, d: 22 }
    const lunar = parseContactDate({ kind: 'birthday', calendar: 'lunar', month: 1, day: 1 }, lunarToday)
    expect(buildReminder(lunar, lunarToday)).toMatchObject({ state: 'upcoming', days: 3, text: '还剩 3 天' })
  })

  it('自己写的名称按周年算，生日这个词才用岁', () => {
    const named = parseContactDate(
      { kind: '乔迁', calendar: 'solar', month: 10, day: 10, year: 2020 },
      today,
    )
    expect(named.kind).toBe('乔迁')
    expect(buildReminder(named, today)?.age_text).toBe('6年0个月5天')
    const legacy = parseContactDate(
      { kind: 'birthday', calendar: 'solar', month: 10, day: 18, year: 2000 },
      today,
    )
    expect(legacy.kind).toBe('生日')
    expect(() => parseContactDate({ kind: '  ', calendar: 'solar', month: 1, day: 1 }, today)).toThrow(/须为/)
    expect(() => parseContactDate({ kind: '一二三四五六七八九十一二三四五六七', calendar: 'solar', month: 1, day: 1 }, today)).toThrow(/须为/)
  })

  it('拒绝不存在的闰月和阳历日期', () => {
    expect(() =>
      parseContactDate({ kind: 'birthday', calendar: 'lunar', month: 1, day: 1, year: 2020, leap: true }, today),
    ).toThrow(/无效/)
    expect(() =>
      parseContactDate({ kind: 'birthday', calendar: 'solar', month: 2, day: 29, year: 2026 }, today),
    ).toThrow(/无效/)
    expect(() => parseContactDate({ kind: 'birthday', calendar: 'solar', month: 4, day: 31 }, today)).toThrow(/无效/)
  })

  it('接口能保存阳历生日，人情列表带上提醒', async () => {
    const { app } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'date1', password: 'password1' }),
    })
    const body = reg.body as { token: string; ledgers: { id: number }[] }
    const headers = {
      authorization: `Bearer ${body.token}`,
      'x-ledger-id': String(body.ledgers[0].id),
      'content-type': 'application/json',
    }
    const soon = addDays(shanghaiDate(), 3)
    const month = Number(soon.slice(5, 7))
    const day = Number(soon.slice(8, 10))
    const created = await json(app, '/api/v1/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '张三',
        relation: '朋友',
        date: { kind: 'birthday', calendar: 'solar', month, day, year: 2000 },
      }),
    })
    expect(created.status).toBe(201)
    const saved = created.body as { date: { kind: string; label: string }; reminder: { text: string; age_text: string } }
    expect(saved.date.kind).toBe('生日')
    expect(saved.date.label).toBe(`阳历 2000年${month}月${day}日`)
    const dict = await json(app, '/api/v1/dicts?kind=contact_date', { headers })
    expect((dict.body as { items: { name: string }[] }).items.map((item) => item.name)).toContain('生日')
    const shared = await json(app, '/api/v1/dicts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'contact_date', name: '乔迁', shared: true }),
    })
    expect(shared.status).toBe(200)
    const reused = await json(app, '/api/v1/dicts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'contact_date', name: '乔迁' }),
    })
    expect((reused.body as { id: number }).id).toBe((shared.body as { id: number }).id)
    expect(saved.reminder.text).toBe('还剩 3 天')
    expect(saved.reminder.age_text).toMatch(/岁/)

    const cleared = await json(app, `/api/v1/contacts/${(created.body as { id: number }).id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ date: null }),
    })
    expect(cleared.status).toBe(200)
    expect((cleared.body as { date: unknown }).date).toBeNull()
  })
})

describe('日子字典', () => {
  it('公共字典不挂账本，账本列表也能看到', async () => {
    const db = createSqliteDb(':memory:')
    await ensureMigrated(db)
    await db.run(
      `INSERT INTO dict_items (ledger_id, kind, name, sort_order, archived, created_at) VALUES (NULL, 'contact_date', '生日', 0, 0, 1)`,
    )
    const info = await db.all<{ name: string; notnull: number; type: string }>(`PRAGMA table_info(dict_items)`)
    expect(info.find((col) => col.name === 'ledger_id')?.notnull).toBe(0)
    expect(info.find((col) => col.name === 'kind')?.type).toBe('TEXT')
    expect(info.find((col) => col.name === 'name')?.type).toBe('TEXT')
    const listed = await listDictItems(db, 7, 'contact_date')
    expect(listed.map((item) => item.name)).toEqual(['生日'])
    const reused = await ensureDictItem(db, 7, 'contact_date', '生日')
    expect(reused.id).toBe(listed[0].id)
  })

})

describe('工具页模式', () => {
  it('缺省是原生，后台可以切到 H5，未登录也能读到', async () => {
    const { app } = await setup()
    const open = await json(app, '/api/v1/app/tools')
    expect(open.status).toBe(200)
    expect(open.body).toEqual({ mode: 'native' })

    const login = await json(app, '/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
    const token = (login.body as { token: string }).token
    const denied = await json(app, '/api/v1/admin/tools', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'h5' }),
    })
    expect(denied.status).toBe(401)

    const saved = await json(app, '/api/v1/admin/tools', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'h5' }),
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({ mode: 'h5' })

    const again = await json(app, '/api/v1/app/tools')
    expect(again.body).toEqual({ mode: 'h5' })

    const bad = await json(app, '/api/v1/admin/tools', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'web' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('工具页交接码', () => {
  it('用一次就失效，库里没有明文', async () => {
    const { app, db } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'hand1', password: 'password1' }),
    })
    const body = reg.body as { token: string; ledgers: { id: number }[] }
    const headers = {
      authorization: `Bearer ${body.token}`,
      'x-ledger-id': String(body.ledgers[0].id),
      'content-type': 'application/json',
    }
    const issued = await json(app, '/api/v1/webview/handoff', { method: 'POST', headers, body: '{}' })
    expect(issued.status).toBe(200)
    const code = (issued.body as { code: string; expires_in: number }).code
    expect(code).toMatch(/^[0-9a-f]{48}$/)
    expect((issued.body as { expires_in: number }).expires_in).toBe(300)
    const stored = await db.all<{ code_hash: string }>(`SELECT code_hash FROM handoff_codes`)
    expect(stored.some((row) => row.code_hash === code)).toBe(false)

    const session = await json(app, '/api/v1/auth/webview-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(session.status).toBe(200)
    expect((session.body as { ledger_id: number }).ledger_id).toBe(body.ledgers[0].id)
    expect((session.body as { token: string }).token).toBeTruthy()

    const again = await json(app, '/api/v1/auth/webview-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(again.status).toBe(401)

    const bad = await json(app, '/api/v1/auth/webview-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'nope' }),
    })
    expect(bad.status).toBe(400)
  })

  it('过期的码换不回会话', async () => {
    const { db } = await setup()
    const user = await db.first<{ id: number }>(`SELECT id FROM users LIMIT 1`)
    expect(user).toBeNull()
    await db.run(
      `INSERT INTO users (username, nickname, password_hash, created_at) VALUES ('h2', 'h', 'x', 1)`,
    )
    const created = await db.first<{ id: number }>(`SELECT id FROM users WHERE username = 'h2'`)
    if (!created) throw new Error('no user')
    const issued = await issueHandoff(db, created.id, 0)
    await db.run(`UPDATE handoff_codes SET expires_at = ?`, [Date.now() - 1000])
    await expect(redeemHandoff(db, issued.code)).rejects.toThrow(/失效/)
  })
})

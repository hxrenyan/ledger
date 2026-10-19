import { describe, expect, it } from 'vitest'
import { mergeUserStmts } from '../src/auth/mergeUser.ts'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

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
  return { status: res.status, body: body as Record<string, any> }
}

async function register(app: ReturnType<typeof createApp>, username: string) {
  const res = await json(app, '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  })
  const token = res.body.token as string
  const userId = res.body.user.id as number
  const ledgerId = res.body.ledgers[0].id as number
  const headers = (ledger = ledgerId) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-ledger-id': String(ledger),
  })
  return { token, userId, ledgerId, headers }
}

describe('个人日历记事', () => {
  it('只属于自己，换账本还在，同账本的人看不到', async () => {
    const { app, db } = await setup()
    const owner = await register(app, 'owner')
    const mate = await register(app, 'mate')
    const invite = await db.first<{ invite_code: string }>(
      `SELECT invite_code FROM ledgers WHERE id = ?`,
      [owner.ledgerId],
    )
    const joined = await json(app, '/api/v1/ledgers/join', {
      method: 'POST',
      headers: mate.headers(),
      body: JSON.stringify({ code: invite?.invite_code }),
    })
    expect(joined.status).toBe(201)

    const another = await json(app, '/api/v1/ledgers', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ name: '另一本' }),
    })
    expect(another.status).toBe(201)

    const missing = await json(app, '/api/v1/day-notes?day=2026-10-19', {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    expect(missing.status).toBe(400)

    const blank = await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ day: '2026-10-19', body: '   ' }),
    })
    expect(blank.status).toBe(400)
    const tooLong = await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ day: '2026-10-19', body: '记'.repeat(201) }),
    })
    expect(tooLong.status).toBe(400)
    const badDay = await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ day: '2026-02-31', body: '不存在的一天' }),
    })
    expect(badDay.status).toBe(400)

    const first = await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ day: '2026-10-19', body: '早上开会' }),
    })
    expect(first.status).toBe(201)
    const second = await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ day: '2026-10-19', body: '晚上买菜' }),
    })
    expect(second.status).toBe(201)
    const later = await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: owner.headers(),
      body: JSON.stringify({ day: '2027-01-02', body: '还没到的事' }),
    })
    expect(later.status).toBe(201)

    const day = await json(app, '/api/v1/day-notes?day=2026-10-19', { headers: owner.headers() })
    expect(day.body.items.map((item: { body: string }) => item.body)).toEqual(['早上开会', '晚上买菜'])

    const month = await json(app, '/api/v1/day-notes?month=2026-10', { headers: owner.headers() })
    expect(month.body.days).toEqual([{ day: '2026-10-19', count: 2 }])
    expect(month.body.items.map((item: { body: string }) => item.body)).toEqual(['早上开会', '晚上买菜'])

    const switched = await json(app, '/api/v1/day-notes?day=2026-10-19', {
      headers: owner.headers(another.body.id),
    })
    expect(switched.body.items).toHaveLength(2)

    const hidden = await json(app, '/api/v1/day-notes?day=2026-10-19', {
      headers: mate.headers(owner.ledgerId),
    })
    expect(hidden.body.items).toEqual([])
    const stolen = await json(app, `/api/v1/day-notes/${first.body.id}`, {
      method: 'PATCH',
      headers: mate.headers(owner.ledgerId),
      body: JSON.stringify({ body: '改掉别人的' }),
    })
    expect(stolen.status).toBe(404)

    const plan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT day, COUNT(*) FROM day_notes
       WHERE user_id = ? AND day >= ? AND day < ?
       GROUP BY day`,
      [owner.userId, '2026-10-01', '2026-11-01'],
    )
    expect(plan.some((row) => row.detail.includes('idx_day_notes_user_day'))).toBe(true)

    const edited = await json(app, `/api/v1/day-notes/${second.body.id}`, {
      method: 'PATCH',
      headers: owner.headers(),
      body: JSON.stringify({ body: '晚上买菜和水果' }),
    })
    expect(edited.status).toBe(200)
    expect(edited.body.body).toBe('晚上买菜和水果')

    const removed = await json(app, `/api/v1/day-notes/${first.body.id}`, {
      method: 'DELETE',
      headers: owner.headers(),
    })
    expect(removed.body).toEqual({ ok: true })
    const removedAgain = await json(app, `/api/v1/day-notes/${second.body.id}`, {
      method: 'DELETE',
      headers: owner.headers(),
    })
    expect(removedAgain.status).toBe(200)
    const empty = await json(app, '/api/v1/day-notes?month=2026-10', { headers: owner.headers() })
    expect(empty.body.days).toEqual([])
  })

  it('按自选时间范围列出记事，最长一年', async () => {
    const { app, db } = await setup()
    const owner = await register(app, 'owner')
    const other = await register(app, 'other')
    const notes = [
      ['2026-01-01', '年初交房租'],
      ['2026-06-15', '年中体检'],
      ['2027-01-01', '满一年'],
      ['2027-01-02', '超出一天'],
      ['2024-02-29', '闰日'],
      ['2025-02-28', '次年二月底'],
      ['2025-03-01', '再晚一天'],
    ]
    for (const [day, body] of notes) {
      const created = await json(app, '/api/v1/day-notes', {
        method: 'POST',
        headers: owner.headers(),
        body: JSON.stringify({ day, body }),
      })
      expect(created.status).toBe(201)
    }
    await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: other.headers(),
      body: JSON.stringify({ day: '2026-06-15', body: '别人的体检' }),
    })

    const year = await json(app, '/api/v1/day-notes?from=2026-01-01&to=2027-01-01', {
      headers: owner.headers(),
    })
    expect(year.status).toBe(200)
    expect(year.body.from).toBe('2026-01-01')
    expect(year.body.to).toBe('2027-01-01')
    expect(year.body.items.map((item: { body: string }) => item.body)).toEqual(['年初交房租', '年中体检', '满一年'])
    expect(year.body.days).toEqual([
      { day: '2026-01-01', count: 1 },
      { day: '2026-06-15', count: 1 },
      { day: '2027-01-01', count: 1 },
    ])

    const over = await json(app, '/api/v1/day-notes?from=2026-01-01&to=2027-01-02', {
      headers: owner.headers(),
    })
    expect(over.status).toBe(400)
    expect(over.body.message).toBe('时间范围不能超过一年')

    const reversed = await json(app, '/api/v1/day-notes?from=2026-06-15&to=2026-01-01', {
      headers: owner.headers(),
    })
    expect(reversed.status).toBe(400)

    const half = await json(app, '/api/v1/day-notes?from=2026-01-01', { headers: owner.headers() })
    expect(half.status).toBe(400)

    const mixed = await json(app, '/api/v1/day-notes?month=2026-01&from=2026-01-01&to=2026-02-01', {
      headers: owner.headers(),
    })
    expect(mixed.status).toBe(400)

    const leap = await json(app, '/api/v1/day-notes?from=2024-02-29&to=2025-02-28', {
      headers: owner.headers(),
    })
    expect(leap.status).toBe(200)
    expect(leap.body.items.map((item: { body: string }) => item.body)).toEqual(['闰日', '次年二月底'])
    const leapOver = await json(app, '/api/v1/day-notes?from=2024-02-29&to=2025-03-01', {
      headers: owner.headers(),
    })
    expect(leapOver.status).toBe(400)

    const hidden = await json(app, '/api/v1/day-notes?from=2026-01-01&to=2026-12-31', {
      headers: other.headers(),
    })
    expect(hidden.body.items.map((item: { body: string }) => item.body)).toEqual(['别人的体检'])

    const plan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id, day, body, created_at, updated_at FROM day_notes
       WHERE user_id = ? AND day >= ? AND day <= ?
       ORDER BY day ASC, created_at ASC, id ASC`,
      [owner.userId, '2026-01-01', '2027-01-01'],
    )
    expect(plan.some((row) => row.detail.includes('idx_day_notes_user_day'))).toBe(true)
  })

  it('微信账号合并后记事跟到留下的账号', async () => {
    const { app, db } = await setup()
    const kept = await register(app, 'kept')
    const dropped = await register(app, 'dropped')
    await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: kept.headers(),
      body: JSON.stringify({ day: '2026-10-01', body: '留下的' }),
    })
    await json(app, '/api/v1/day-notes', {
      method: 'POST',
      headers: dropped.headers(),
      body: JSON.stringify({ day: '2026-10-02', body: '并过来的' }),
    })
    await db.run(
      `INSERT INTO user_identities (provider, openid, user_id, unionid, created_at) VALUES ('wechat', ?, ?, NULL, ?)`,
      ['merge-openid', dropped.userId, Date.now()],
    )
    const stmts = await mergeUserStmts(db, dropped.userId, kept.userId, 'merge-openid')
    await db.batch(stmts)

    const mine = await json(app, '/api/v1/day-notes?month=2026-10', { headers: kept.headers() })
    expect(mine.body.days).toEqual([
      { day: '2026-10-01', count: 1 },
      { day: '2026-10-02', count: 1 },
    ])
    const orphan = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM day_notes WHERE user_id = ?`,
      [dropped.userId],
    )
    expect(Number(orphan?.n)).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import type { WechatIdentity } from '../src/auth/wechat.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { HttpError } from '../src/http.ts'

const JWT = 'test-secret-test-secret'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const exchange = async (code: string): Promise<WechatIdentity> => {
    if (code !== 'ok') throw new HttpError(401, 'wechat_code', '微信登录已失效，请重试')
    return { openid: 'openid-points', unionid: null }
  }
  const app = createApp({ db, jwtSecret: JWT, adminToken: 'admin-secret', exchangeWechatCode: exchange })
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

async function adminToken(app: ReturnType<typeof createApp>) {
  const login = await json(app, '/api/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-secret' }),
  })
  return (login.body as { token: string }).token
}

function adminPost(token: string, path: string, body: unknown) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('管理后台分配积分', () => {
  it('只给微信用户加减，并写入明细', async () => {
    const { app, db } = await setup()
    const token = await adminToken(app)

    const password = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'pwduser', password: 'password1' }),
    })
    const passwordId = (password.body as { user: { id: number } }).user.id

    const wechat = await json(app, '/api/v1/auth/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ok' }),
    })
    const wechatId = (wechat.body as { user: { id: number } }).user.id

    const denied = await json(app, `/api/v1/admin/users/${passwordId}/points`, adminPost(token, '', { delta: 10, note: '不该成功' }))
    expect(denied.status).toBe(400)

    const missing = await json(app, '/api/v1/admin/users/999999/points', adminPost(token, '', { delta: 10, note: '没有这个人' }))
    expect(missing.status).toBe(404)

    const bad = await json(app, `/api/v1/admin/users/${wechatId}/points`, adminPost(token, '', { delta: 1.5, note: '小数' }))
    expect(bad.status).toBe(400)

    const granted = await json(app, `/api/v1/admin/users/${wechatId}/points`, adminPost(token, '', { delta: 10, note: '活动补发' }))
    expect(granted.status).toBe(200)
    expect((granted.body as { balance: number }).balance).toBe(20)

    const again = await json(app, `/api/v1/admin/users/${wechatId}/points`, adminPost(token, '', { delta: 5, note: '再补' }))
    expect((again.body as { balance: number }).balance).toBe(25)

    const tooMuch = await json(app, `/api/v1/admin/users/${wechatId}/points`, adminPost(token, '', { delta: -30, note: '扣多了' }))
    expect(tooMuch.status).toBe(400)
    const still = await db.first<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, [wechatId])
    expect(still?.balance).toBe(25)

    const deducted = await json(app, `/api/v1/admin/users/${wechatId}/points`, adminPost(token, '', { delta: -5, note: '扣回' }))
    expect(deducted.status).toBe(200)
    expect((deducted.body as { balance: number; entry: { kind: string; balance_after: number } }).entry.kind).toBe('admin_deduct')
    expect((deducted.body as { balance: number }).balance).toBe(20)

    const list = await json(app, '/api/v1/admin/points', { headers: { authorization: `Bearer ${token}` } })
    const items = (list.body as { items: { id: number; balance: number }[] }).items
    expect(items.map((item) => item.id)).toEqual([wechatId])
    expect(items[0].balance).toBe(20)

    const detail = await json(app, `/api/v1/admin/users/${wechatId}/points`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const entries = (detail.body as { balance: number; items: { delta: number; note: string }[] }).items
    expect((detail.body as { balance: number }).balance).toBe(20)
    expect(entries.map((item) => item.delta)).toEqual([-5, 5, 10, 10])
    expect(entries[2].note).toBe('活动补发')

    const plan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM point_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
      [wechatId],
    )
    expect(plan.some((row) => row.detail.includes('idx_point_entries_user'))).toBe(true)
  })

  it('批量分配要么全部写入，要么一个都不写', async () => {
    const { app, db } = await setup()
    const token = await adminToken(app)
    const now = Date.now()
    await db.run(`INSERT INTO users (username, nickname, created_at) VALUES ('wx_b', '小红', ?)`, [now])
    const second = await db.first<{ id: number }>(`SELECT id FROM users WHERE username = 'wx_b'`)
    await db.run(
      `INSERT INTO user_identities (provider, openid, user_id, created_at) VALUES ('wechat', 'openid-b', ?, ?)`,
      [second!.id, now],
    )
    const first = await json(app, '/api/v1/auth/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ok' }),
    })
    const firstId = (first.body as { user: { id: number } }).user.id
    const password = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'pwduser2', password: 'password1' }),
    })
    const passwordId = (password.body as { user: { id: number } }).user.id

    const granted = await json(app, '/api/v1/admin/points', adminPost(token, '', {
      user_ids: [firstId, second!.id],
      delta: 8,
      note: '批量补发',
    }))
    expect(granted.status).toBe(200)
    const grantedItems = (granted.body as { items: { user_id: number; balance_after: number; delta: number }[] }).items
    expect(grantedItems.map((item) => item.balance_after)).toEqual([18, 8])

    const blocked = await json(app, '/api/v1/admin/points', adminPost(token, '', {
      user_ids: [firstId, passwordId],
      delta: 3,
      note: '不该成功',
    }))
    expect(blocked.status).toBe(400)
    const untouched = await db.first<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, [firstId])
    expect(untouched?.balance).toBe(18)

    const short = await json(app, '/api/v1/admin/points', adminPost(token, '', {
      user_ids: [firstId, second!.id],
      delta: -20,
      note: '扣多了',
    }))
    expect(short.status).toBe(400)
    expect((short.body as { message: string }).message).toContain('小红')
    const stillFirst = await db.first<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, [firstId])
    const stillSecond = await db.first<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, [second!.id])
    expect(stillFirst?.balance).toBe(18)
    expect(stillSecond?.balance).toBe(8)
    const count = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM point_entries`)
    expect(Number(count?.n)).toBe(3)
  })
})

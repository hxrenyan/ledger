import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({
    db,
    jwtSecret: 'test-secret-test-secret',
    adminToken: 'admin-secret',
    exchangeWechatCode: async (code) => ({ openid: `fb-${code}`, unionid: null }),
  })
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
  return { token, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }
}

describe('用户反馈', () => {
  it('提交后只有自己能看到，后台可以回复并标成已处理', async () => {
    const { app, db } = await setup()
    const author = await register(app, 'author')
    const other = await register(app, 'other')
    const empty = await json(app, '/api/v1/feedbacks', {
      method: 'POST',
      headers: author.headers,
      body: JSON.stringify({ content: '   ' }),
    })
    expect(empty.status).toBe(400)

    const created = await json(app, '/api/v1/feedbacks', {
      method: 'POST',
      headers: author.headers,
      body: JSON.stringify({ content: '导出按钮不好找', contact: 'wx_author' }),
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ content: '导出按钮不好找', contact: 'wx_author', status: 'open' })

    const mine = await json(app, '/api/v1/feedbacks', { headers: author.headers })
    expect(mine.body.items).toHaveLength(1)
    const theirs = await json(app, '/api/v1/feedbacks', { headers: other.headers })
    expect(theirs.body.items).toEqual([])

    const plan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM feedbacks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
      [1],
    )
    expect(plan.some((row) => row.detail.includes('idx_feedbacks_user'))).toBe(true)

    const adminLogin = await json(app, '/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
    const adminHeaders = {
      authorization: `Bearer ${adminLogin.body.token}`,
      'content-type': 'application/json',
    }
    const open = await json(app, '/api/v1/admin/feedbacks?status=open', { headers: adminHeaders })
    expect(open.body.items).toHaveLength(1)
    expect(open.body.items[0].username).toBe('author')
    const statusPlan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM feedbacks WHERE status = 'open' ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
    expect(statusPlan.some((row) => row.detail.includes('idx_feedbacks_status'))).toBe(true)
    const recentPlan = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM feedbacks ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
    expect(recentPlan.some((row) => row.detail.includes('idx_feedbacks_recent'))).toBe(true)

    const id = created.body.id
    const saved = await json(app, `/api/v1/admin/feedbacks/${id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'done', reply: '下个版本放到更显眼的位置' }),
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({ status: 'done', reply: '下个版本放到更显眼的位置' })

    const after = await json(app, '/api/v1/feedbacks', { headers: author.headers })
    expect(after.body.items[0]).toMatchObject({
      status_label: '已处理',
      reply: '下个版本放到更显眼的位置',
    })
    const stillOpen = await json(app, '/api/v1/admin/feedbacks?status=open', { headers: adminHeaders })
    expect(stillOpen.body.items).toEqual([])
  })

  it('同一天超过 10 条会被拒绝', async () => {
    const { app } = await setup()
    const user = await register(app, 'noisy')
    for (let i = 0; i < 10; i++) {
      const res = await json(app, '/api/v1/feedbacks', {
        method: 'POST',
        headers: user.headers,
        body: JSON.stringify({ content: `第 ${i + 1} 条` }),
      })
      expect(res.status).toBe(201)
    }
    const extra = await json(app, '/api/v1/feedbacks', {
      method: 'POST',
      headers: user.headers,
      body: JSON.stringify({ content: '第 11 条' }),
    })
    expect(extra.status).toBe(400)
    expect(String(extra.body.message)).toContain('10')
  })

  it('绑定密码账号后反馈跟着过去', async () => {
    const { app } = await setup()
    await register(app, 'keep_feedback')
    const wx = await json(app, '/api/v1/auth/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ok' }),
    })
    const wxHeaders = { authorization: `Bearer ${wx.body.token}`, 'content-type': 'application/json' }
    const created = await json(app, '/api/v1/feedbacks', {
      method: 'POST',
      headers: wxHeaders,
      body: JSON.stringify({ content: '绑定前写的' }),
    })
    expect(created.status).toBe(201)
    const bound = await json(app, '/api/v1/me/wechat/bind', {
      method: 'POST',
      headers: wxHeaders,
      body: JSON.stringify({ username: 'keep_feedback', password: 'password1' }),
    })
    expect(bound.status).toBe(200)
    const list = await json(app, '/api/v1/feedbacks', {
      headers: { authorization: `Bearer ${bound.body.token}`, 'content-type': 'application/json' },
    })
    expect(list.body.items).toMatchObject([{ content: '绑定前写的' }])
  })
})

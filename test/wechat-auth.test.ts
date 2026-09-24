import { describe, expect, it, afterEach } from 'vitest'
import { createApp } from '../src/app.ts'
import { exchangeWechatCode, type WechatIdentity } from '../src/auth/wechat.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { HttpError } from '../src/http.ts'

const JWT = 'test-secret-test-secret'

type SessionUser = {
  id: string
  username: string
  nickname: string
  has_password: boolean
  wechat_bound: boolean
}

type SessionBody = {
  token: string
  user: SessionUser
  ledgers: { id: string; name: string; role: string }[]
}

async function setup(exchange?: (code: string) => Promise<WechatIdentity> | WechatIdentity) {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({
    db,
    jwtSecret: JWT,
    adminToken: 'admin-secret',
    exchangeWechatCode: exchange
      ? async (code) => {
          const got = await exchange(code)
          return got
        }
      : undefined,
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
  return { status: res.status, body }
}

function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

function identities(openid: string, unionid?: string) {
  return async (code: string): Promise<WechatIdentity> => {
    if (code === 'bad') throw new HttpError(401, 'wechat_code', '微信登录已失效，请重试')
    if (code !== 'ok' && code !== 'ok2') throw new HttpError(401, 'wechat_code', '微信登录已失效，请重试')
    if (code === 'ok2') return { openid: `${openid}-2`, unionid: null }
    return { openid, unionid: unionid ?? null }
  }
}

describe('微信 code 换 openid', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('成功时只返回 openid / unionid，不带 session_key', async () => {
    let called = ''
    const fetchImpl: typeof fetch = async (input) => {
      called = String(input)
      return new Response(JSON.stringify({ openid: 'openid_1', unionid: 'union_1', session_key: 'secret-key' }))
    }
    const got = await exchangeWechatCode('wx-app', 'wx-secret', 'code-1', fetchImpl)
    expect(got).toEqual({ openid: 'openid_1', unionid: 'union_1' })
    expect(called).toContain('appid=wx-app')
    expect(called).toContain('secret=wx-secret')
    expect(called).toContain('js_code=code-1')
    expect(called).toContain('grant_type=authorization_code')
  })

  it('失效 code、错误配置、其它错误分别映射', async () => {
    const respond = (body: unknown) => async () => new Response(JSON.stringify(body))
    await expect(exchangeWechatCode('a', 'b', 'c', respond({ errcode: 40029, errmsg: 'invalid code' }))).rejects.toMatchObject({
      status: 401,
      code: 'wechat_code',
    })
    await expect(exchangeWechatCode('a', 'b', 'c', respond({ errcode: 40125, errmsg: 'invalid appsecret' }))).rejects.toMatchObject({
      status: 503,
      code: 'wechat_unconfigured',
    })
    await expect(exchangeWechatCode('a', 'b', 'c', respond({ errcode: 45011, errmsg: 'freq' }))).rejects.toMatchObject({
      status: 502,
      code: 'wechat_failed',
    })
  })
})

describe('小程序登录与绑定已有账号', () => {
  it('未配置时 503，缺 code 时 400', async () => {
    const { app } = await setup()
    const missing = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', {}))
    expect(missing.status).toBe(503)
    expect((missing.body as { code: string }).code).toBe('wechat_unconfigured')

    const { app: ready } = await setup(identities('oid-1'))
    const noCode = await json(ready, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', {}))
    expect(noCode.status).toBe(400)
  })

  it('新微信建临时账号，再次登录还是同一个人', async () => {
    const { app, db } = await setup(identities('oid-1', 'union-1'))
    const first = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    expect(first.status).toBe(201)
    const created = first.body as SessionBody
    expect(created.user.nickname).toBe('微信用户')
    expect(created.user.has_password).toBe(false)
    expect(created.user.wechat_bound).toBe(true)
    expect(created.user.username.startsWith('wx_')).toBe(true)
    expect(created.ledgers).toHaveLength(1)

    const again = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    expect(again.status).toBe(200)
    expect((again.body as SessionBody).user.id).toBe(created.user.id)

    const row = await db.first<{ unionid: string; n: number }>(
      `SELECT unionid, (SELECT COUNT(*) FROM user_identities) AS n FROM user_identities WHERE openid = 'oid-1'`,
    )
    expect(row).toEqual({ unionid: 'union-1', n: 1 })

    const byOpenid = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT user_id FROM user_identities WHERE provider = 'wechat' AND openid = 'oid-1'`,
    )
    const byUser = await db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT openid FROM user_identities WHERE provider = 'wechat' AND user_id = ?`,
      [created.user.id],
    )
    expect(byOpenid.map((r) => r.detail).join(' ')).toContain('openid')
    expect(byUser.map((r) => r.detail).join(' ')).toContain('idx_user_identities_user')
  })

  it('绑定已有账号后改发该账号的 token，并删掉空的临时账本', async () => {
    const { app, db } = await setup(identities('oid-bind'))
    const reg = await json(app, '/api/v1/auth/register', post('/api/v1/auth/register', { username: 'alice', password: 'password1', nickname: '爱丽丝' }))
    expect(reg.status).toBe(201)
    const alice = reg.body as SessionBody

    const wx = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    const shadow = wx.body as SessionBody
    expect(wx.status).toBe(201)

    const bound = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'alice', password: 'password1' }, shadow.token))
    expect(bound.status).toBe(200)
    const next = bound.body as SessionBody
    expect(next.user.id).toBe(alice.user.id)
    expect(next.user.username).toBe('alice')
    expect(next.user.has_password).toBe(true)
    expect(next.user.wechat_bound).toBe(true)
    expect(next.ledgers.map((l) => l.id)).toEqual(alice.ledgers.map((l) => l.id))
    expect(next.token).not.toBe(shadow.token)

    const self = await json(
      app,
      '/api/v1/me/wechat/bind',
      post('/api/v1/me/wechat/bind', { username: 'alice', password: 'password1' }, next.token),
    )
    expect(self.status).toBe(400)

    const old = await json(app, '/api/v1/me', { headers: { authorization: `Bearer ${shadow.token}` } })
    expect(old.status).toBe(401)
    const me = await json(app, '/api/v1/me', { headers: { authorization: `Bearer ${next.token}` } })
    expect((me.body as SessionBody).user.id).toBe(alice.user.id)

    const again = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    expect((again.body as SessionBody).user.id).toBe(alice.user.id)

    expect(await db.first(`SELECT id FROM users WHERE id = ?`, [shadow.user.id])).toBeNull()
    expect(await db.first(`SELECT id FROM ledgers WHERE id = ?`, [shadow.ledgers[0].id])).toBeNull()
    expect(await db.first<{ user_id: string }>(`SELECT user_id FROM user_identities WHERE openid = 'oid-bind'`)).toEqual({
      user_id: alice.user.id,
    })
  })

  it('密码错误不合并；目标已绑过微信时保持两边原样', async () => {
    const { app, db } = await setup(identities('oid-keep'))
    await json(app, '/api/v1/auth/register', post('/api/v1/auth/register', { username: 'bob', password: 'password1' }))
    const wx = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    const shadow = wx.body as SessionBody

    const wrong = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'bob', password: 'nope-nope' }, shadow.token))
    expect(wrong.status).toBe(401)
    expect(await db.first(`SELECT id FROM users WHERE id = ?`, [shadow.user.id])).toEqual({ id: shadow.user.id })

    const second = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok2' }))
    const other = second.body as SessionBody
    const firstBind = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'bob', password: 'password1' }, other.token))
    expect(firstBind.status).toBe(200)

    const taken = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'bob', password: 'password1' }, shadow.token))
    expect(taken.status).toBe(409)
    expect(await db.first<{ user_id: string }>(`SELECT user_id FROM user_identities WHERE openid = 'oid-keep'`)).toEqual({
      user_id: shadow.user.id,
    })
  })

  it('绑定后两边数据并进密码账号，微信和密码都能登', async () => {
    const { app, db } = await setup(identities('oid-merge'))
    const reg = await json(app, '/api/v1/auth/register', post('/api/v1/auth/register', { username: 'alice', password: 'password1', nickname: '爱丽丝' }))
    const alice = reg.body as SessionBody
    const aliceLedger = alice.ledgers[0].id
    const wx = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    const shadow = wx.body as SessionBody
    const wxLedger = shadow.ledgers[0].id

    const aliceCash = await db.first<{ id: string }>(`SELECT id FROM accounts WHERE ledger_id = ? AND name = '现金'`, [aliceLedger])
    const wxCash = await db.first<{ id: string }>(`SELECT id FROM accounts WHERE ledger_id = ? AND name = '现金'`, [wxLedger])
    const aliceFood = await db.first<{ id: string }>(
      `SELECT id FROM categories WHERE ledger_id = ? AND name = '餐饮' AND kind = 'expense'`,
      [aliceLedger],
    )
    const wxFood = await db.first<{ id: string }>(
      `SELECT id FROM categories WHERE ledger_id = ? AND name = '餐饮' AND kind = 'expense'`,
      [wxLedger],
    )
    if (!aliceCash || !wxCash || !aliceFood || !wxFood) throw new Error('默认账户或分类缺失')

    await db.run(`UPDATE accounts SET current_cents = -2300 WHERE id = ?`, [aliceCash.id])
    await db.run(`UPDATE accounts SET current_cents = -5000 WHERE id = ?`, [wxCash.id])
    await db.run(
      `INSERT INTO transactions (ledger_id, account_id, category_id, kind, amount_cents, occurred_at, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'expense', 2300, 10, '网页午饭', ?, 10, 10)`,
      [aliceLedger, aliceCash.id, aliceFood.id, alice.user.id],
    )
    const wxTx = await db.first<{ id: number }>(
      `INSERT INTO transactions (ledger_id, account_id, category_id, kind, amount_cents, occurred_at, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'expense', 5000, 20, '微信晚饭', ?, 20, 20) RETURNING id`,
      [wxLedger, wxCash.id, wxFood.id, shadow.user.id],
    )
    const fund = await db.first<{ id: number }>(
      `INSERT INTO accounts (ledger_id, name, type, sort_order, archived, current_cents, created_at)
       VALUES (?, '公积金', 'other', 9, 0, 8000, 1) RETURNING id`,
      [wxLedger],
    )
    const aliceContact = await db.first<{ id: number }>(
      `INSERT INTO contacts (ledger_id, name, relation, archived, created_at) VALUES (?, '张三', '同事', 0, 1) RETURNING id`,
      [aliceLedger],
    )
    const wxContact = await db.first<{ id: number }>(
      `INSERT INTO contacts (ledger_id, name, relation, archived, created_at) VALUES (?, '张三', '', 0, 2) RETURNING id`,
      [wxLedger],
    )
    const gift = await db.first<{ id: number }>(
      `INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occasion, occurred_at, note, created_by, created_at, updated_at)
       VALUES (?, ?, 'give', 20000, '婚礼', 30, '微信随礼', ?, 30, 30) RETURNING id`,
      [wxLedger, wxContact?.id, shadow.user.id],
    )
    await db.run(
      `INSERT INTO budgets (ledger_id, category_id, month, amount_cents, created_at) VALUES (?, ?, '2026-03', 10000, 1)`,
      [aliceLedger, aliceFood.id],
    )
    await db.run(
      `INSERT INTO budgets (ledger_id, category_id, month, amount_cents, created_at) VALUES (?, ?, '2026-03', 2500, 2)`,
      [wxLedger, wxFood.id],
    )
    const recurrence = await db.first<{ id: number }>(
      `INSERT INTO recurrences (ledger_id, kind, amount_cents, account_id, category_id, note, day_of_month, next_at, enabled, created_at)
       VALUES (?, 'expense', 100, ?, ?, '房租', 1, 40, 1, 40) RETURNING id`,
      [wxLedger, wxCash.id, wxFood.id],
    )
    await db.run(
      `INSERT INTO attachments (transaction_id, ledger_id, mime, bytes, created_at) VALUES (?, ?, 'image/png', ?, 1)`,
      [wxTx?.id, wxLedger, Buffer.from('png')],
    )
    if (!wxTx || !fund || !aliceContact || !wxContact || !gift || !recurrence) throw new Error('测试数据写入失败')

    const bound = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'alice', password: 'password1' }, shadow.token))
    expect(bound.status).toBe(200)
    const next = bound.body as SessionBody
    expect(next.user).toMatchObject({ id: alice.user.id, username: 'alice', nickname: '爱丽丝', has_password: true, wechat_bound: true })
    expect(next.ledgers.map((l) => l.id)).toEqual([aliceLedger])

    const notes = await db.all<{ note: string; account_id: string; category_id: string; created_by: string }>(
      `SELECT note, account_id, category_id, created_by FROM transactions WHERE ledger_id = ? ORDER BY occurred_at`,
      [aliceLedger],
    )
    expect(notes).toEqual([
      { note: '网页午饭', account_id: aliceCash.id, category_id: aliceFood.id, created_by: alice.user.id },
      { note: '微信晚饭', account_id: aliceCash.id, category_id: aliceFood.id, created_by: alice.user.id },
    ])
    expect(await db.first(`SELECT current_cents FROM accounts WHERE id = ?`, [aliceCash.id])).toEqual({ current_cents: -7300 })
    expect(await db.first(`SELECT ledger_id, current_cents FROM accounts WHERE id = ?`, [fund.id])).toEqual({
      ledger_id: aliceLedger,
      current_cents: 8000,
    })
    expect(await db.first(`SELECT COUNT(*) AS n FROM contacts WHERE ledger_id = ? AND name = '张三'`, [aliceLedger])).toEqual({ n: 1 })
    expect(await db.first(`SELECT ledger_id, contact_id, created_by FROM gifts WHERE id = ?`, [gift.id])).toEqual({
      ledger_id: aliceLedger,
      contact_id: aliceContact.id,
      created_by: alice.user.id,
    })
    expect(await db.first(`SELECT ledger_id, category_id, amount_cents FROM budgets WHERE month = '2026-03'`)).toEqual({
      ledger_id: aliceLedger,
      category_id: aliceFood.id,
      amount_cents: 12500,
    })
    expect(await db.first(`SELECT ledger_id, account_id, category_id FROM recurrences WHERE id = ?`, [recurrence.id])).toEqual({
      ledger_id: aliceLedger,
      account_id: aliceCash.id,
      category_id: aliceFood.id,
    })
    expect(await db.first(`SELECT ledger_id FROM attachments WHERE transaction_id = ?`, [wxTx.id])).toEqual({ ledger_id: aliceLedger })
    expect(await db.first(`SELECT id FROM users WHERE id = ?`, [shadow.user.id])).toBeNull()
    expect(await db.first(`SELECT id FROM ledgers WHERE id = ?`, [wxLedger])).toBeNull()

    const byPassword = await json(app, '/api/v1/auth/login', post('/api/v1/auth/login', { username: 'alice', password: 'password1' }))
    expect((byPassword.body as SessionBody).user.id).toBe(alice.user.id)
    expect((byPassword.body as SessionBody).user.wechat_bound).toBe(true)
    const byWechat = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    expect((byWechat.body as SessionBody).user.id).toBe(alice.user.id)
  })

  it('有其他成员的账本只移交，不把流水拆进私人账本', async () => {
    const { app, db } = await setup(identities('oid-share'))
    const reg = await json(app, '/api/v1/auth/register', post('/api/v1/auth/register', { username: 'alice', password: 'password1' }))
    const alice = reg.body as SessionBody
    const wx = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    const shadow = wx.body as SessionBody
    const other = await db.first<{ id: number }>(
      `INSERT INTO users (username, nickname, created_at) VALUES ('other', '其他人', 1) RETURNING id`,
    )
    const fam = await db.first<{ id: number }>(
      `INSERT INTO ledgers (name, owner_id, invite_code, created_at) VALUES ('家庭', ?, 'INVITE01', 1) RETURNING id`,
      [shadow.user.id],
    )
    if (!other || !fam) throw new Error('家庭账本写入失败')
    await db.run(
      `INSERT INTO members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'owner', 1), (?, ?, 'member', 1)`,
      [fam.id, shadow.user.id, fam.id, other.id],
    )
    const famTx = await db.first<{ id: number }>(
      `INSERT INTO transactions (ledger_id, account_id, kind, amount_cents, occurred_at, note, created_by, created_at, updated_at)
       VALUES (?, 1, 'expense', 100, 1, '家庭餐', ?, 1, 1) RETURNING id`,
      [fam.id, shadow.user.id],
    )
    if (!famTx) throw new Error('家庭流水写入失败')

    const bound = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'alice', password: 'password1' }, shadow.token))
    expect(bound.status).toBe(200)
    expect(await db.first(`SELECT owner_id FROM ledgers WHERE id = ?`, [fam.id])).toEqual({ owner_id: alice.user.id })
    expect(await db.first(`SELECT role FROM members WHERE ledger_id = ? AND user_id = ?`, [fam.id, alice.user.id])).toEqual({ role: 'owner' })
    expect(await db.first(`SELECT user_id FROM members WHERE ledger_id = ? AND user_id = ?`, [fam.id, shadow.user.id])).toBeNull()
    expect(await db.first(`SELECT ledger_id, note, created_by FROM transactions WHERE id = ?`, [famTx.id])).toEqual({
      ledger_id: fam.id,
      note: '家庭餐',
      created_by: alice.user.id,
    })
    expect((bound.body as SessionBody).ledgers.map((l) => l.id).sort()).toEqual([alice.ledgers[0].id, fam.id].sort())
  })

  it('停用的目标账号不能绑，没有微信身份也不能绑', async () => {
    const { app, db } = await setup(identities('oid-off'))
    const reg = await json(app, '/api/v1/auth/register', post('/api/v1/auth/register', { username: 'cara', password: 'password1' }))
    const cara = reg.body as SessionBody
    await db.run(`UPDATE users SET disabled = 1 WHERE id = ?`, [cara.user.id])

    const wx = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    const shadow = wx.body as SessionBody
    const disabled = await json(app, '/api/v1/me/wechat/bind', post('/api/v1/me/wechat/bind', { username: 'cara', password: 'password1' }, shadow.token))
    expect(disabled.status).toBe(401)
    expect((disabled.body as { message: string }).message).toBe('账号已停用')

    const dana = await json(app, '/api/v1/auth/register', post('/api/v1/auth/register', { username: 'dana', password: 'password1' }))
    const plain = await json(
      app,
      '/api/v1/me/wechat/bind',
      post('/api/v1/me/wechat/bind', { username: 'cara', password: 'password1' }, (dana.body as SessionBody).token),
    )
    expect(plain.status).toBe(400)
    expect((plain.body as { message: string }).message).toBe('当前账号还没有微信登录，无法绑定')

    await db.run(`UPDATE users SET disabled = 1 WHERE id = ?`, [shadow.user.id])
    const again = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'ok' }))
    expect(again.status).toBe(401)
  })

  it('配置了 AppId 时走 jscode2session', async () => {
    const db = createSqliteDb(':memory:')
    await ensureMigrated(db)
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ openid: 'from-weixin' }))
    try {
      const app = createApp({
        db,
        jwtSecret: JWT,
        wechatAppId: 'wx-app',
        wechatAppSecret: 'wx-secret',
      })
      const res = await json(app, '/api/v1/auth/wechat', post('/api/v1/auth/wechat', { code: 'live' }))
      expect(res.status).toBe(201)
      expect((res.body as SessionBody).user.wechat_bound).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})

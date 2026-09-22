import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { patchSchema } from '../src/db/patch.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { upgradeSchema } from '../src/db/upgrade.ts'
import { centsToYuan, yuanExprToCents, yuanToCents } from '../src/money.ts'
import { addDays, shanghaiMonthRange } from '../src/time.ts'

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
  return { status: res.status, body, res }
}

function authHeaders(token: string, ledgerId: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'x-ledger-id': ledgerId, 'content-type': 'application/json' }
}

describe('migrate old sqlite', () => {
  it('旧库缺列时先补列再建模索引', async () => {
    const db = createSqliteDb(':memory:')
    await db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        nickname TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE ledgers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        ledger_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        to_account_id TEXT,
        category_id TEXT,
        kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO users (id, username, nickname, created_at) VALUES ('u1', 'old', '旧', 1);
      INSERT INTO ledgers (id, name, owner_id, created_at) VALUES ('l1', '旧账本', 'u1', 1);
    `)
    await ensureMigrated(db)
    const users = await db.all<{ name: string }>(`PRAGMA table_info(users)`)
    const ledgers = await db.all<{ name: string }>(`PRAGMA table_info(ledgers)`)
    const txs = await db.all<{ name: string }>(`PRAGMA table_info(transactions)`)
    expect(users.some((c) => c.name === 'disabled')).toBe(true)
    expect(ledgers.some((c) => c.name === 'invite_code')).toBe(true)
    expect(txs.some((c) => c.name === 'has_receipt')).toBe(true)
    const row = await db.first<{ invite_code: string }>(`SELECT invite_code FROM ledgers WHERE id = 'l1'`)
    expect(row?.invite_code).toMatch(/^[A-Z0-9]{8}$/)
  })

  it('旧库合并模型配置，并去掉死字段', async () => {
    const db = createSqliteDb(':memory:')
    await db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        wx_openid TEXT UNIQUE,
        wx_unionid TEXT,
        nickname TEXT NOT NULL DEFAULT '',
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users (id, username, password_hash, wx_openid, wx_unionid, nickname, disabled, created_at)
      VALUES ('u1', 'old', 'hash', 'openid', 'union', '旧', 0, 1);

      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        ledger_id TEXT NOT NULL,
        name TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO contacts (id, ledger_id, name, relation, note, archived, created_at)
      VALUES ('c1', 'l1', '张三', '同事', '备注', 0, 1);

      CREATE TABLE recurrences (
        id TEXT PRIMARY KEY,
        ledger_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        to_account_id TEXT,
        category_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        day_of_month INTEGER NOT NULL,
        next_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      INSERT INTO recurrences (
        id, ledger_id, kind, amount_cents, account_id, to_account_id, category_id, note, day_of_month, next_at, enabled, created_at
      ) VALUES ('r1', 'l1', 'expense', 100, 'a1', 'a2', 'cat', '房租', 1, 1, 1, 1);

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        ledger_id TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE ai_settings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO ai_settings (id, name, enabled, base_url, api_key, model, sort_order, updated_at)
      VALUES ('same', '解析', 1, 'https://llm.example', 'k1', 'm1', 0, 1);

      CREATE TABLE asr_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        protocol TEXT NOT NULL DEFAULT 'openai-audio',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO asr_profiles (id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
      VALUES ('same', '语音', 1, 'openai-audio', 'https://asr.example', 'k2', 'm2', 1, 2);
    `)
    await db.run(
      `INSERT INTO attachments (id, transaction_id, ledger_id, mime, bytes, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['att', 'tx1', 'l1', 'image/png', Buffer.from('png-bytes'), 9, 1],
    )

    await ensureMigrated(db)
    await ensureMigrated(db)
    await patchSchema(db)

    const userCols = (await db.all<{ name: string }>(`PRAGMA table_info(users)`)).map((col) => col.name)
    expect(userCols).not.toContain('wx_openid')
    expect(userCols).not.toContain('wx_unionid')
    expect(await db.first(`SELECT username, password_hash FROM users WHERE id = 'u1'`)).toEqual({
      username: 'old',
      password_hash: 'hash',
    })

    const contactCols = (await db.all<{ name: string }>(`PRAGMA table_info(contacts)`)).map((col) => col.name)
    expect(contactCols).not.toContain('note')
    expect(await db.first(`SELECT name, relation FROM contacts WHERE id = 'c1'`)).toEqual({
      name: '张三',
      relation: '同事',
    })

    const recurrenceCols = (await db.all<{ name: string }>(`PRAGMA table_info(recurrences)`)).map((col) => col.name)
    expect(recurrenceCols).not.toContain('to_account_id')
    expect(await db.first<{ note: string }>(`SELECT note FROM recurrences WHERE id = 'r1'`)).toEqual({ note: '房租' })

    const attachmentCols = await db.all<{ name: string; pk: number }>(`PRAGMA table_info(attachments)`)
    expect(attachmentCols.find((col) => col.name === 'transaction_id')?.pk).toBe(1)
    expect(attachmentCols.some((col) => col.name === 'id' || col.name === 'size')).toBe(false)
    expect(await db.first(`SELECT mime, length(bytes) AS n FROM attachments WHERE transaction_id = 'tx1'`)).toEqual({
      mime: 'image/png',
      n: 9,
    })

    expect(
      await db.all(`SELECT kind, id, name, api_key FROM ai_profiles ORDER BY kind`),
    ).toEqual([
      { kind: 'asr', id: 'same', name: '语音', api_key: 'k2' },
      { kind: 'llm', id: 'same', name: '解析', api_key: 'k1' },
    ])
    const tables = (await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((row) => row.name)
    expect(tables).not.toContain('ai_settings')
    expect(tables).not.toContain('asr_profiles')
    expect(tables).not.toContain('users_new')
    expect(tables).not.toContain('attachments_new')
  })

  it('建表中断留下的 users_new 下次能改回 users', async () => {
    const db = createSqliteDb(':memory:')
    await db.exec(`CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      nickname TEXT NOT NULL DEFAULT '',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`)
    await db.run(
      `INSERT INTO users_new (id, username, nickname, disabled, created_at) VALUES ('u', 'a', 'n', 0, 1)`,
    )
    await upgradeSchema(db)
    expect(await db.first(`SELECT username FROM users WHERE id = 'u'`)).toEqual({ username: 'a' })
    await upgradeSchema(db)
    expect(await db.first(`SELECT username FROM users WHERE id = 'u'`)).toEqual({ username: 'a' })
  })
})

describe('money / time', () => {
  it('yuan 与分互转无浮点误差', () => {
    expect(yuanToCents('1.23')).toBe(123)
    expect(yuanToCents(10.1)).toBe(1010)
    expect(centsToYuan(1010)).toBe('10.10')
    expect(centsToYuan(0)).toBe('0.00')
  })

  it('金额表达式按分计算', () => {
    expect(yuanExprToCents('12+8')).toBe(2000)
    expect(yuanExprToCents('3*4')).toBe(1200)
    expect(yuanExprToCents('10/4')).toBe(250)
    expect(yuanExprToCents('12.5+0.5')).toBe(1300)
    expect(yuanExprToCents('12++8')).toBeNull()
    expect(yuanExprToCents('0')).toBeNull()
  })

  it('上海月份区间为左闭右开', () => {
    const { start, end } = shanghaiMonthRange('2026-03')
    expect(end).toBeGreaterThan(start)
    expect(end - start).toBe(31 * 24 * 3600 * 1000)
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('auth & isolation', () => {
  it('注册后一人一账本，他人不可读', async () => {
    const { app } = await setup()
    const a = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password1', nickname: '爱丽丝' }),
    })
    expect(a.status).toBe(201)
    const aBody = a.body as { token: string; ledgers: { id: string }[] }
    expect(aBody.ledgers).toHaveLength(1)

    const b = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password1' }),
    })
    const bBody = b.body as { token: string; ledgers: { id: string }[] }

    const steal = await json(app, '/api/v1/accounts', {
      headers: authHeaders(bBody.token, aBody.ledgers[0].id),
    })
    expect(steal.status).toBe(403)

    const dup = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password1' }),
    })
    expect(dup.status).toBe(409)
  })

  it('登录成功并发 JWT', async () => {
    const { app } = await setup()
    await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password1' }),
    })
    const login = await json(app, '/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password1' }),
    })
    expect(login.status).toBe(200)
    expect((login.body as { token: string }).token).toBeTruthy()
  })
})

describe('transactions & stats', () => {
  it('记账后月统计正确，微信登录预留 501', async () => {
    const { app } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dave', password: 'password1' }),
    })
    const { token, ledgers } = reg.body as { token: string; ledgers: { id: string }[] }
    const headers = authHeaders(token, ledgers[0].id)

    const accounts = await json(app, '/api/v1/accounts', { headers })
    const categories = await json(app, '/api/v1/categories', { headers })
    const accId = (accounts.body as { items: { id: string }[] }).items[0].id
    const cats = (categories.body as { items: { id: string; kind: string }[] }).items
    const expenseCat = cats.find((x) => x.kind === 'expense')!.id
    const incomeCat = cats.find((x) => x.kind === 'income')!.id

    const exp = await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 2300,
        account_id: accId,
        category_id: expenseCat,
        date: '2026-03-10',
        note: '午饭',
      }),
    })
    expect(exp.status).toBe(201)

    const inc = await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'income',
        amount_cents: 100000,
        account_id: accId,
        category_id: incomeCat,
        date: '2026-03-01',
      }),
    })
    expect(inc.status).toBe(201)

    const stats = await json(app, '/api/v1/stats/monthly?month=2026-03', { headers })
    expect(stats.status).toBe(200)
    const s = stats.body as { income_cents: number; expense_cents: number; net_cents: number }
    expect(s.income_cents).toBe(100000)
    expect(s.expense_cents).toBe(2300)
    expect(s.net_cents).toBe(97700)

    const wx = await json(app, '/api/v1/auth/wechat', { method: 'POST' })
    expect(wx.status).toBe(501)

    const csvRes = await app.request('/api/v1/export', { headers })
    expect(csvRes.status).toBe(200)
    const csv = await csvRes.text()
    expect(csv).toContain('日期')
    expect(csv).toContain('午饭')
    expect(csvRes.headers.get('content-type') || '').toContain('csv')
  })
})

describe('v2 ledgers / transfer / budget / admin', () => {
  it('邀请加入后可记账，原主人不可被他人偷看失败已覆盖', async () => {
    const { app } = await setup()
    const a = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'host1', password: 'password1' }),
    })
    const aBody = a.body as { token: string; ledgers: { id: string }[] }
    const aHeaders = authHeaders(aBody.token, aBody.ledgers[0].id)
    const members = await json(app, '/api/v1/members', { headers: aHeaders })
    const code = (members.body as { invite_code: string }).invite_code
    expect(code).toMatch(/^[A-Z0-9]{8}$/)

    const b = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'guest1', password: 'password1' }),
    })
    const bBody = b.body as { token: string; ledgers: { id: string }[] }
    const joined = await json(app, '/api/v1/ledgers/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${bBody.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(joined.status).toBe(201)
    const guestSee = await json(app, '/api/v1/accounts', {
      headers: authHeaders(bBody.token, aBody.ledgers[0].id),
    })
    expect(guestSee.status).toBe(200)
  })

  it('转账不计入收支，预算按支出累计', async () => {
    const { app } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'xfer', password: 'password1' }),
    })
    const { token, ledgers } = reg.body as { token: string; ledgers: { id: string }[] }
    const headers = authHeaders(token, ledgers[0].id)
    const accounts = (await json(app, '/api/v1/accounts', { headers })).body as { items: { id: string }[] }
    const cats = (await json(app, '/api/v1/categories', { headers })).body as { items: { id: string; kind: string }[] }
    const expenseCat = cats.items.find((x) => x.kind === 'expense')!.id

    const xfer = await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'transfer',
        amount_cents: 5000,
        account_id: accounts.items[0].id,
        to_account_id: accounts.items[1].id,
        date: '2026-03-02',
      }),
    })
    expect(xfer.status).toBe(201)

    await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 2000,
        account_id: accounts.items[0].id,
        category_id: expenseCat,
        date: '2026-03-03',
      }),
    })

    const budget = await json(app, '/api/v1/budgets', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ month: '2026-03', amount_cents: 10000, category_id: '' }),
    })
    expect(budget.status).toBe(201)

    const stats = await json(app, '/api/v1/stats/monthly?month=2026-03', { headers })
    const s = stats.body as { expense_cents: number; income_cents: number; budget_cents: number }
    expect(s.income_cents).toBe(0)
    expect(s.expense_cents).toBe(2000)
    expect(s.budget_cents).toBe(10000)
  })

  it('收据写入 SQLite，管理员可停用用户', async () => {
    const { app } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'picuser', password: 'password1' }),
    })
    const { token, ledgers, user } = reg.body as {
      token: string
      ledgers: { id: string }[]
      user: { id: string }
    }
    const headers = authHeaders(token, ledgers[0].id)
    const accounts = (await json(app, '/api/v1/accounts', { headers })).body as { items: { id: string }[] }
    const cats = (await json(app, '/api/v1/categories', { headers })).body as { items: { id: string; kind: string }[] }
    const tx = await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 100,
        account_id: accounts.items[0].id,
        category_id: cats.items.find((x) => x.kind === 'expense')!.id,
        date: '2026-03-04',
      }),
    })
    const txId = (tx.body as { id: string }).id
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (ch) => ch.charCodeAt(0),
    )
    const fd = new FormData()
    fd.append('file', new File([png], 'a.png', { type: 'image/png' }))
    const rec = await app.request(`/api/v1/transactions/${txId}/receipt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-ledger-id': ledgers[0].id },
      body: fd,
    })
    expect(rec.status).toBe(200)

    const img = await app.request(`/api/v1/transactions/${txId}/receipt`, {
      headers: { authorization: `Bearer ${token}`, 'x-ledger-id': ledgers[0].id },
    })
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')

    const steal = await json(app, '/api/v1/admin/overview', { headers: { authorization: `Bearer ${token}` } })
    expect(steal.status).toBe(403)

    const login = await json(app, '/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
    expect(login.status).toBe(200)
    const adminToken = (login.body as { token: string }).token
    const overview = await json(app, '/api/v1/admin/overview', {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(overview.status).toBe(200)
    expect((overview.body as { users: number }).users).toBeGreaterThanOrEqual(1)

    const stop = await json(app, `/api/v1/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    })
    expect(stop.status).toBe(200)
    const again = await json(app, '/api/v1/accounts', { headers })
    expect(again.status).toBe(401)
  })
})

describe('人情往来', () => {
  it('按人汇总送出与收入，他人账本不可见', async () => {
    const { app } = await setup()
    const a = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'favor_a', password: 'password1' }),
    })
    const aBody = a.body as { token: string; ledgers: { id: string }[] }
    const headers = authHeaders(aBody.token, aBody.ledgers[0].id)

    const person = await json(app, '/api/v1/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '张三', relation: '同事' }),
    })
    expect(person.status).toBe(201)
    const contactId = (person.body as { id: string }).id

    const give = await json(app, '/api/v1/gifts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'give',
        contact_id: contactId,
        amount_cents: 80000,
        occasion: '结婚',
        date: '2026-03-08',
      }),
    })
    expect(give.status).toBe(201)

    const recv = await json(app, '/api/v1/gifts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'receive',
        contact_id: contactId,
        amount_cents: 20000,
        occasion: '满月',
        date: '2026-04-01',
      }),
    })
    expect(recv.status).toBe(201)

    const give2 = await json(app, '/api/v1/gifts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'give',
        contact_id: contactId,
        amount_cents: 5000,
        occasion: '过年',
        date: '2026-02-01',
      }),
    })
    expect(give2.status).toBe(201)
    const edited = await json(app, `/api/v1/gifts/${(give2.body as { id: string }).id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        kind: 'give',
        contact_id: contactId,
        amount_cents: 6000,
        occasion: '过年',
        date: '2026-02-01',
      }),
    })
    expect(edited.status).toBe(200)
    expect((edited.body as { amount_cents: number }).amount_cents).toBe(6000)

    const list = await json(app, '/api/v1/contacts', { headers })
    const zhang = (list.body as { items: { name: string; given_cents: number; received_cents: number; net_cents: number }[] }).items.find(
      (x) => x.name === '张三',
    )
    expect(zhang?.given_cents).toBe(86000)
    expect(zhang?.received_cents).toBe(20000)
    expect(zhang?.net_cents).toBe(-66000)

    const b = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'favor_b', password: 'password1' }),
    })
    const bBody = b.body as { token: string; ledgers: { id: string }[] }
    const steal = await json(app, '/api/v1/contacts', {
      headers: authHeaders(bBody.token, aBody.ledgers[0].id),
    })
    expect(steal.status).toBe(403)
  })
})

describe('余额 / 统计 / 周期', () => {
  it('支出减少余额，不计入不影响统计，周期可跑', async () => {
    const { app } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bal1', password: 'password1' }),
    })
    const { token, ledgers } = reg.body as { token: string; ledgers: { id: string }[] }
    const headers = authHeaders(token, ledgers[0].id)
    const acc = (await json(app, '/api/v1/accounts', { headers })).body as {
      items: { id: string; current_cents: number }[]
      net_cents: number
    }
    const accId = acc.items[0].id
    await json(app, `/api/v1/accounts/${accId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ current_cents: 100000 }),
    })
    const cats = (await json(app, '/api/v1/categories', { headers })).body as { items: { id: string; kind: string }[] }
    const expenseCat = cats.items.find((x) => x.kind === 'expense')!.id
    await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 2000,
        account_id: accId,
        category_id: expenseCat,
        date: '2026-03-10',
      }),
    })
    const after = (await json(app, '/api/v1/accounts', { headers })).body as {
      items: { id: string; current_cents: number }[]
    }
    expect(after.items.find((x) => x.id === accId)?.current_cents).toBe(98000)

    await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 5000,
        account_id: accId,
        category_id: expenseCat,
        date: '2026-03-11',
        excluded: true,
      }),
    })
    const stats = await json(app, '/api/v1/stats/monthly?month=2026-03', { headers })
    expect((stats.body as { expense_cents: number }).expense_cents).toBe(2000)

    const rec = await json(app, '/api/v1/recurrences', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 100,
        account_id: accId,
        category_id: expenseCat,
        day_of_month: 1,
        note: '测试周期',
      }),
    })
    expect(rec.status).toBe(201)
    const run = await json(app, '/api/v1/recurrences/run', { method: 'POST', headers })
    expect(run.status).toBe(200)
  })
})

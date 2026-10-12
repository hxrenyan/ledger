import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { addDays, shanghaiDate } from '../src/time.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({
    db,
    jwtSecret: 'test-secret-test-secret',
    adminToken: 'admin-secret',
    exchangeWechatCode: async (code) => ({ openid: `wx-points-${code}`, unionid: null }),
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

async function wechat(app: ReturnType<typeof createApp>, code = 'ok') {
  const login = await json(app, '/api/v1/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const token = login.body.token as string
  const user = login.body.user as { id: number }
  const ledgers = login.body.ledgers as { id: string }[]
  return {
    token,
    userId: user.id,
    headers: {
      authorization: `Bearer ${token}`,
      'x-ledger-id': ledgers[0].id,
      'content-type': 'application/json',
    },
  }
}

async function restrict(db: Awaited<ReturnType<typeof setup>>['db']) {
  await db.run(`INSERT INTO app_configs (key, value, updated_at) VALUES ('recognition.restricted', '1', ?)`, [Date.now()])
}

async function password(app: ReturnType<typeof createApp>, username: string) {
  const reg = await json(app, '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  })
  const token = reg.body.token as string
  const ledgers = reg.body.ledgers as { id: string }[]
  return {
    token,
    headers: {
      authorization: `Bearer ${token}`,
      'x-ledger-id': ledgers[0].id,
      'content-type': 'application/json',
    },
  }
}

describe('微信积分', () => {
  it('新建微信用户送 10 分，再次登录不重送', async () => {
    const { app, db } = await setup()
    const first = await wechat(app, 'once')
    expect(first.userId).toBeTruthy()
    const summary = await json(app, '/api/v1/points', { headers: first.headers })
    expect(summary.body).toMatchObject({ wechat: true, balance: 10, streak: 0, today_checked: false })
    const entries = await json(app, '/api/v1/points/entries', { headers: first.headers })
    expect(entries.body.items).toMatchObject([{ title: '新用户赠送', delta: 10, balance_after: 10 }])

    const same = await json(app, '/api/v1/auth/wechat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'once' }),
    })
    expect(same.status).toBe(200)
    const rows = await db.all(`SELECT id FROM point_entries WHERE kind = 'signup_grant'`)
    expect(rows).toHaveLength(1)
    const still = await json(app, '/api/v1/points', { headers: first.headers })
    expect(still.body.balance).toBe(10)
  })

  it('小程序当天第一次进入 +1，网页和不带头都不发', async () => {
    const { app } = await setup()
    const user = await wechat(app)
    const web = await json(app, '/api/v1/points/check-in', { method: 'POST', headers: user.headers })
    expect(web.body).toMatchObject({ balance: 10, granted_daily: 0, today_checked: false })

    const mini = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...user.headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(mini.body).toMatchObject({ balance: 11, streak: 1, granted_daily: 1, granted_streak: 0, today_checked: true })

    const twice = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...user.headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(twice.body).toMatchObject({ balance: 11, granted_daily: 0, granted_streak: 0 })
  })

  it('连续第 5 天额外 +2，断一天从 1 重新计', async () => {
    const { app, db } = await setup()
    const user = await wechat(app, 'day5')
    const today = shanghaiDate()
    await db.run(`INSERT INTO point_checkins (user_id, last_day, streak, updated_at) VALUES (?, ?, 4, ?)`, [
      user.userId,
      addDays(today, -1),
      Date.now(),
    ])
    const day5 = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...user.headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(day5.body).toMatchObject({ balance: 13, streak: 5, granted_daily: 1, granted_streak: 2 })
    expect(String(day5.body.message)).toContain('额外 +2')

    const gap = await wechat(app, 'gap')
    await db.run(`INSERT INTO point_checkins (user_id, last_day, streak, updated_at) VALUES (?, ?, 9, ?)`, [
      gap.userId,
      addDays(today, -2),
      Date.now(),
    ])
    const reset = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...gap.headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(reset.body).toMatchObject({ balance: 11, streak: 1, granted_daily: 1, granted_streak: 0 })
  })

  it('密码账号没有积分，也不能做语音、图片和文本整理', async () => {
    const { app, db } = await setup()
    await restrict(db)
    const user = await password(app, 'pwd_points')
    const check = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...user.headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(check.body).toMatchObject({ wechat: false, balance: 0, granted_daily: 0 })
    expect(await db.first(`SELECT user_id FROM point_accounts`)).toBeNull()

    const text = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers: user.headers,
      body: JSON.stringify({ text: '午饭35' }),
    })
    expect(text.status).toBe(403)
    expect(String(text.body.message)).toContain('仅支持微信登录')

    const form = new FormData()
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' }))
    form.set('duration_ms', '2000')
    const speech = await json(app, '/api/v1/speech/transcribe', {
      method: 'POST',
      headers: { authorization: user.headers.authorization, 'x-ledger-id': user.headers['x-ledger-id'] },
      body: form,
    })
    expect(speech.status).toBe(403)
  })

  it('微信用户整理一句午饭扣 1 分；余额不够时不占次数', async () => {
    const { app, db } = await setup()
    await restrict(db)
    const user = await wechat(app)
    const ok = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers: user.headers,
      body: JSON.stringify({ text: '午饭35' }),
    })
    expect(ok.status).toBe(200)
    expect(ok.body.points).toMatchObject({ charged: 1, balance: 9 })

    await db.run(`UPDATE point_accounts SET balance = 0 WHERE user_id = ?`, [user.userId])
    const form = new FormData()
    form.set('file', new File([new Uint8Array(80)], 'a.mp3', { type: 'audio/mpeg' }))
    form.set('duration_ms', '2000')
    const speech = await json(app, '/api/v1/speech/transcribe', {
      method: 'POST',
      headers: { authorization: user.headers.authorization, 'x-ledger-id': user.headers['x-ledger-id'] },
      body: form,
    })
    expect(speech.status).toBe(402)
    expect(speech.body.code).toBe('insufficient_points')
    expect(String(speech.body.message)).toContain('还差')
    const calls = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM point_calls WHERE user_id = ?`, [user.userId])
    expect(Number(calls?.n)).toBe(1)
  })

  it('没有可入账的图片文字会退回预估积分', async () => {
    const { app, db } = await setup()
    await restrict(db)
    const user = await wechat(app)
    const res = await json(app, '/api/v1/imports/receipt', {
      method: 'POST',
      headers: user.headers,
      body: JSON.stringify({ text: '合计 23.00\n2026-09-23 午饭' }),
    })
    expect(res.status).toBe(200)
    expect(res.body.points).toMatchObject({ charged: 0, balance: 10 })
    const kinds = await db.all<{ kind: string }>(
      `SELECT kind FROM point_entries WHERE user_id = ? ORDER BY id`,
      [user.userId],
    )
    expect(kinds.map((row) => row.kind)).toEqual(['signup_grant', 'image', 'refund'])
  })

  it('限制关闭时密码账号可以整理文本，不扣积分', async () => {
    const { app, db } = await setup()
    const user = await password(app, 'free_text')
    const text = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers: user.headers,
      body: JSON.stringify({ text: '午饭35' }),
    })
    expect(text.status).toBe(200)
    expect(text.body.points).toMatchObject({ charged: 0, balance: 0 })
    expect(await db.first(`SELECT user_id FROM point_accounts`)).toBeNull()

    const login = await json(app, '/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
    const admin = { authorization: `Bearer ${login.body.token}`, 'content-type': 'application/json' }
    const before = await json(app, '/api/v1/admin/recognition', { headers: admin })
    expect(before.body).toEqual({ restricted: false })
    const saved = await json(app, '/api/v1/admin/recognition', {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ restricted: true }),
    })
    expect(saved.body).toEqual({ restricted: true })
    const blocked = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers: user.headers,
      body: JSON.stringify({ text: '午饭35' }),
    })
    expect(blocked.status).toBe(403)
  })

  it('积分上线前的微信账号补一次注册赠送，已有明细的不再送', async () => {
    const { db } = await setup()
    const now = Date.now()
    await db.run(
      `INSERT INTO users (username, password_hash, nickname, disabled, created_at) VALUES ('wx_old', NULL, '旧用户', 0, ?)`,
      [now],
    )
    await db.run(
      `INSERT INTO user_identities (provider, openid, user_id, unionid, created_at)
       VALUES ('wechat', 'old-openid', (SELECT id FROM users WHERE username = 'wx_old'), NULL, ?)`,
      [now],
    )
    const { grantMissingSignups } = await import('../src/points/wallet.ts')
    expect(await grantMissingSignups(db)).toBe(1)
    const summary = await db.first<{ balance: number }>(
      `SELECT balance FROM point_accounts WHERE user_id = (SELECT id FROM users WHERE username = 'wx_old')`,
    )
    expect(summary?.balance).toBe(10)
    expect(await grantMissingSignups(db)).toBe(0)
    const again = await db.first<{ balance: number }>(
      `SELECT balance FROM point_accounts WHERE user_id = (SELECT id FROM users WHERE username = 'wx_old')`,
    )
    expect(again?.balance).toBe(10)
  })

  it('绑定密码账号后余额和当天签到一起迁过去', async () => {
    const { app } = await setup()
    const pwd = await password(app, 'keep_me')
    const wx = await wechat(app)
    const checked = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...wx.headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(checked.body.balance).toBe(11)

    const bound = await json(app, '/api/v1/me/wechat/bind', {
      method: 'POST',
      headers: { authorization: wx.headers.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'keep_me', password: 'password1' }),
    })
    expect(bound.status).toBe(200)
    const token = bound.body.token as string
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const summary = await json(app, '/api/v1/points', { headers })
    expect(summary.body).toMatchObject({ wechat: true, balance: 11, streak: 1, today_checked: true })
    const again = await json(app, '/api/v1/points/check-in', {
      method: 'POST',
      headers: { ...headers, 'x-ledger-client': 'miniprogram' },
    })
    expect(again.body).toMatchObject({ balance: 11, granted_daily: 0 })
    expect(pwd.token).toBeTruthy()
  })
})

import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

/**
 * web-view 混合架构的服务端契约。
 *
 * 重点守住两件事：
 * 1. 交接码必须一次性、短命、不可枚举——它是绕过密码直接换会话的凭据。
 * 2. 页面归属表只能把「允许切 web-view 的长尾页」切过去，
 *    依赖微信能力的原生页被切成 web-view 会让功能直接不可用。
 */

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

type Session = {
  token: string
  user: { id: string }
  ledgers: { id: string; name: string; role: string }[]
  ledger_id?: string
}

/** 注册一个新用户，返回会话与默认账本 id。 */
async function registerUser(app: ReturnType<typeof createApp>, username: string) {
  const r = await json(app, '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'passw0rd!', nickname: username }),
  })
  expect(r.status).toBe(201)
  const session = r.body as Session
  return { session, ledgerId: session.ledgers[0].id }
}

function authHeaders(token: string, ledgerId?: string): HeadersInit {
  const h: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  if (ledgerId) h['x-ledger-id'] = ledgerId
  return h
}

async function issueCode(app: ReturnType<typeof createApp>, token: string, ledgerId?: string) {
  const r = await json(app, '/api/v1/webview/handoff', {
    method: 'POST',
    headers: authHeaders(token, ledgerId),
    body: JSON.stringify({}),
  })
  expect(r.status).toBe(200)
  return r.body as { code: string; expires_in: number }
}

async function redeem(app: ReturnType<typeof createApp>, code: unknown) {
  return json(app, '/api/v1/auth/webview-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
}

async function adminLogin(app: ReturnType<typeof createApp>) {
  const r = await json(app, '/api/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-secret' }),
  })
  expect(r.status).toBe(200)
  return (r.body as { token: string }).token
}

describe('web-view 会话交接码', () => {
  it('签发后能换回同一用户的会话与账本', async () => {
    const { app } = await setup()
    const { session, ledgerId } = await registerUser(app, 'webalice')

    const { code, expires_in } = await issueCode(app, session.token, ledgerId)
    expect(code).toMatch(/^[0-9a-f]{48}$/)
    expect(expires_in).toBe(300)

    const r = await redeem(app, code)
    expect(r.status).toBe(200)
    const web = r.body as Session
    expect(web.user.id).toBe(session.user.id)
    expect(web.token).toBeTruthy()
    expect(web.ledger_id).toBe(ledgerId)
    // 小程序当时的账本要排在最前，网页端首屏才不会跳账本。
    expect(web.ledgers[0].id).toBe(ledgerId)

    // 换回来的 token 要能真的用。
    const me = await json(app, '/api/v1/me', { headers: authHeaders(web.token) })
    expect(me.status).toBe(200)
  })

  it('同一个交接码只能用一次', async () => {
    const { app } = await setup()
    const { session, ledgerId } = await registerUser(app, 'webbob')
    const { code } = await issueCode(app, session.token, ledgerId)

    expect((await redeem(app, code)).status).toBe(200)
    const second = await redeem(app, code)
    expect(second.status).toBe(401)
    expect((second.body as { message: string }).message).toContain('失效')
  })

  it('过期的交接码换不出会话', async () => {
    const { app, db } = await setup()
    const { session, ledgerId } = await registerUser(app, 'webcarol')
    const { code } = await issueCode(app, session.token, ledgerId)

    // 直接把过期时间挪到过去，模拟 5 分钟后再来兑换。
    await db.run(`UPDATE handoff_codes SET expires_at = ?`, [Date.now() - 1000])

    expect((await redeem(app, code)).status).toBe(401)
  })

  it('形状不对的交接码直接 400，不进库', async () => {
    const { app, db } = await setup()
    for (const bad of ['', 'abc', 'Z'.repeat(48), 'a'.repeat(47)]) {
      const r = await redeem(app, bad)
      expect(r.status).toBe(400)
    }
    const rows = await db.all(`SELECT code_hash FROM handoff_codes`)
    expect(rows.length).toBe(0)
  })

  it('签发需要登录', async () => {
    const { app } = await setup()
    const r = await json(app, '/api/v1/webview/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(401)
  })

  it('账本不属于自己时不下发账本，但会话照常签发', async () => {
    const { app } = await setup()
    const { session } = await registerUser(app, 'webdave')

    const r = await json(app, '/api/v1/webview/handoff', {
      method: 'POST',
      headers: authHeaders(session.token, 'not-my-ledger'),
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(200)
    const web = (await redeem(app, (r.body as { code: string }).code)).body as Session
    expect(web.ledger_id).toBe('')
    expect(web.ledgers.length).toBeGreaterThan(0)
  })

  it('库里只存 hash，不存明文', async () => {
    const { app, db } = await setup()
    const { session, ledgerId } = await registerUser(app, 'webeve')
    const { code } = await issueCode(app, session.token, ledgerId)

    const rows = await db.all<{ code_hash: string }>(`SELECT code_hash FROM handoff_codes`)
    expect(rows.length).toBe(1)
    expect(rows[0].code_hash).not.toBe(code)
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('页面归属表', () => {
  it('默认全原生，且未配域名时 web-view 一律关闭', async () => {
    const { app } = await setup()
    const { session } = await registerUser(app, 'cfg1')
    const r = await json(app, '/api/v1/app/config', { headers: authHeaders(session.token) })
    expect(r.status).toBe(200)
    const cfg = (r.body as { webview: { enabled: boolean; host: string; pages: Record<string, { mode: string }> } }).webview
    expect(cfg.enabled).toBe(false)
    expect(cfg.host).toBe('')
    for (const page of Object.values(cfg.pages)) expect(page.mode).toBe('native')
    expect(cfg.pages.budgets).toBeTruthy()
  })

  it('管理员可以灰度把单页切到 web-view', async () => {
    const { app } = await setup()
    const admin = await adminLogin(app)
    const put = await json(app, '/api/v1/admin/app-config', {
      method: 'PUT',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        'webview.host': 'https://ledger.example.com/',
        'webview.enabled': '1',
        'webview.pages': { budgets: { mode: 'webview', path: '/budgets' } },
      }),
    })
    expect(put.status).toBe(200)
    const cfg = (put.body as { webview: { enabled: boolean; host: string; pages: Record<string, { mode: string }> } }).webview
    // host 结尾斜杠要被清掉，否则拼出来会变成双斜杠。
    expect(cfg.host).toBe('https://ledger.example.com')
    expect(cfg.enabled).toBe(true)
    expect(cfg.pages.budgets.mode).toBe('webview')
    // 没点名改的页面保持原生。
    expect(cfg.pages.import.mode).toBe('native')

    const reread = await json(app, '/api/v1/admin/app-config', { headers: { authorization: `Bearer ${admin}` } })
    const persisted = (reread.body as { webview: { pages: Record<string, { mode: string }> } }).webview
    expect(persisted.pages.budgets.mode).toBe('webview')

    // 小程序侧读到的应该是同一份。
    const { session } = await registerUser(app, 'cfg2')
    const forMini = await json(app, '/api/v1/app/config', { headers: authHeaders(session.token) })
    expect((forMini.body as { webview: { enabled: boolean } }).webview.enabled).toBe(true)
  })

  it('拒绝把依赖微信能力的原生页切到 web-view', async () => {
    const { app } = await setup()
    const admin = await adminLogin(app)
    for (const key of ['speak', 'tx-form', 'login']) {
      const r = await json(app, '/api/v1/admin/app-config', {
        method: 'PUT',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ 'webview.pages': { [key]: { mode: 'webview' } } }),
      })
      expect(r.status).toBe(400)
      expect((r.body as { message: string }).message).toContain('不能切到 web-view')
    }
  })

  it('没配域名就启用会被拒，域名格式不对也会被拒', async () => {
    const { app } = await setup()
    const admin = await adminLogin(app)
    const headers = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }

    const noHost = await json(app, '/api/v1/admin/app-config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ 'webview.enabled': '1' }),
    })
    expect(noHost.status).toBe(400)
    expect((noHost.body as { message: string }).message).toContain('webview.host')

    for (const bad of ['ledger.example.com', 'http://ledger.example.com', 'https://ledger.example.com/web']) {
      const r = await json(app, '/api/v1/admin/app-config', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ 'webview.host': bad }),
      })
      expect(r.status).toBe(400)
    }
  })

  it('普通用户改不了配置', async () => {
    const { app } = await setup()
    const { session } = await registerUser(app, 'cfg3')
    const r = await json(app, '/api/v1/admin/app-config', {
      method: 'PUT',
      headers: authHeaders(session.token),
      body: JSON.stringify({ 'webview.enabled': '1' }),
    })
    expect(r.status).toBe(403)
  })
})

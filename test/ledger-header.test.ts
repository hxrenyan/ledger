/**
 * 「缺账本」的状态码回归测试。
 *
 * 背景：账本中间件原本对「已通过鉴权、但没带 X-Ledger-Id」的请求返回 401。
 * 但 401 在客户端（小程序 utils/request.js、H5 web/src/api.ts）的语义是
 * 「登录过期」，会被处理成「清会话 + 跳登录页」。
 *
 * 实际踩到的现象：小程序明细页会调 GET /api/v1/speech/status（它只读全局的
 * 语音模型配置，与账本无关，所以用 withLedger:false 发请求），而该接口当时
 * 不在 LEDGER_OPTIONAL 里 → 服务端回 401「缺少账本」→ 客户端当成掉登录
 * → 用户刚微信登录进明细就被踢回登录页。
 *
 * 这里钉住四条边界：
 *   1. 缺账本必须是 400，不能是 401；
 *   2. 完全没登录仍然是 401（不能被改坏）；
 *   3. 与账本无关的接口允许不带账本访问；
 *   4. 账本不属于自己仍是 403，不能退化成 401。
 */

import { describe, expect, it } from 'vitest'
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
  return { status: res.status, body }
}

/** 注册一个用户，返回 token 与默认账本 id。 */
async function signup(app: ReturnType<typeof createApp>, username: string) {
  const res = await json(app, '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  })
  expect(res.status).toBe(201)
  const body = res.body as { token: string; ledgers: { id: string }[] }
  expect(body.ledgers.length).toBeGreaterThan(0)
  return { token: body.token, ledgerId: body.ledgers[0].id }
}

describe('账本上下文与 401 的边界', () => {
  it('已登录但没带账本头时返回 400，不能是 401', async () => {
    const { app } = await setup()
    const { token } = await signup(app, 'noselect')

    const res = await json(app, '/api/v1/transactions', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain('账本')
  })

  it('完全没登录时仍然是 401', async () => {
    const { app } = await setup()
    const res = await json(app, '/api/v1/transactions', {})
    expect(res.status).toBe(401)
  })

  it('speech/status 与账本无关，不带账本头也能访问', async () => {
    const { app } = await setup()
    const { token } = await signup(app, 'speecher')

    const res = await json(app, '/api/v1/speech/status', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('available')
  })

  it('账本不属于自己时返回 403，不能退化成 401', async () => {
    const { app } = await setup()
    const a = await signup(app, 'owner')
    const b = await signup(app, 'intruder')

    const res = await json(app, '/api/v1/transactions', {
      headers: { authorization: `Bearer ${b.token}`, 'x-ledger-id': a.ledgerId },
    })
    expect(res.status).toBe(403)
  })
})

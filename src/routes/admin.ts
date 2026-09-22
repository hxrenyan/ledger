import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { signAdminToken } from '../auth/jwt.ts'
import { badRequest, notFound, unauthorized } from '../http.ts'
import { readAiConfig, resolveEndpoint, testAi } from '../imports/ai.ts'

export function registerAdminRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/admin/login', async (c) => {
    const expected = c.get('adminToken')
    if (!expected) throw unauthorized('未配置管理员口令')
    const body = await c.req.json().catch(() => ({}))
    const password = typeof body.password === 'string' ? body.password : ''
    if (password !== expected) throw unauthorized('管理员口令错误')
    const token = await signAdminToken(c.get('jwtSecret'))
    return c.json({ token })
  })

  app.get('/api/v1/admin/overview', async (c) => {
    const db = c.get('db')
    const users = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)
    const ledgers = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ledgers`)
    const txs = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions`)
    const disabled = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE disabled = 1`)
    return c.json({
      users: Number(users?.n ?? 0),
      ledgers: Number(ledgers?.n ?? 0),
      transactions: Number(txs?.n ?? 0),
      disabled_users: Number(disabled?.n ?? 0),
    })
  })

  app.get('/api/v1/admin/users', async (c) => {
    const rows = await c.get('db').all<{
      id: string
      username: string
      nickname: string
      disabled: number
      created_at: number
      ledger_count: number
    }>(
      `SELECT u.id, u.username, u.nickname, u.disabled, u.created_at,
              (SELECT COUNT(*) FROM members m WHERE m.user_id = u.id) AS ledger_count
       FROM users u
       ORDER BY u.created_at DESC`,
    )
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        nickname: r.nickname,
        disabled: !!r.disabled,
        created_at: r.created_at,
        ledger_count: Number(r.ledger_count),
      })),
    })
  })

  app.patch('/api/v1/admin/users/:id', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.disabled !== 'boolean') throw badRequest('请提供 disabled')
    const db = c.get('db')
    const user = await db.first(`SELECT id FROM users WHERE id = ?`, [id])
    if (!user) throw notFound('用户不存在')
    await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, [body.disabled ? 1 : 0, id])
    return c.json({ id, disabled: body.disabled })
  })

  app.get('/api/v1/admin/ledgers', async (c) => {    const rows = await c.get('db').all<{
      id: string
      name: string
      owner_username: string
      member_count: number
      tx_count: number
      created_at: number
    }>(
      `SELECT l.id, l.name, l.created_at, u.username AS owner_username,
              (SELECT COUNT(*) FROM members m WHERE m.ledger_id = l.id) AS member_count,
              (SELECT COUNT(*) FROM transactions t WHERE t.ledger_id = l.id) AS tx_count
       FROM ledgers l
       JOIN users u ON u.id = l.owner_id
       ORDER BY l.created_at DESC`,
    )
    return c.json({
      items: rows.map((r) => ({
        ...r,
        member_count: Number(r.member_count),
        tx_count: Number(r.tx_count),
      })),
    })
  })

  // -------------------------------------------------------------------------
  // AI 配置（导入解析用）：全局单行，api_key 只回显掩码，永不下发明文
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/ai', async (c) => {
    const cfg = await readAiConfig(c.get('db'))
    return c.json({
      enabled: cfg.enabled,
      base_url: cfg.baseUrl,
      model: cfg.model,
      has_key: !!cfg.apiKey,
      key_hint: maskKey(cfg.apiKey),
      endpoint: cfg.baseUrl ? resolveEndpoint(cfg.baseUrl) : '',
      updated_at: cfg.updatedAt ?? 0,
    })
  })

  app.put('/api/v1/admin/ai', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const db = c.get('db')
    const current = await readAiConfig(db)
    const enabled = body.enabled === true
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : current.baseUrl
    const model = typeof body.model === 'string' ? body.model.trim() : current.model
    let apiKey = current.apiKey
    if (body.clear_key === true) apiKey = ''
    else if (typeof body.api_key === 'string' && body.api_key.trim()) apiKey = body.api_key.trim()

    if (enabled && (!baseUrl || !apiKey || !model)) {
      throw badRequest('启用 AI 需要同时填写 base_url、api_key、model')
    }
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw badRequest('base_url 需以 http(s):// 开头')

    await db.run(
      `INSERT INTO ai_settings (id, enabled, base_url, api_key, model, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled, base_url = excluded.base_url,
         api_key = excluded.api_key, model = excluded.model, updated_at = excluded.updated_at`,
      [enabled ? 1 : 0, baseUrl, apiKey, model, Date.now()],
    )
    return c.json({ ok: true, enabled, base_url: baseUrl, model, has_key: !!apiKey })
  })

  /** 连通性测试：允许带未保存的临时参数（前端「测试」按钮直接用表单值）。 */
  app.post('/api/v1/admin/ai/test', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const current = await readAiConfig(c.get('db'))
    const cfg = {
      enabled: true,
      baseUrl: typeof body.base_url === 'string' && body.base_url.trim() ? body.base_url.trim() : current.baseUrl,
      apiKey: typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : current.apiKey,
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : current.model,
    }
    const res = await testAi(cfg)
    if (!res.ok) return c.json({ ok: false, message: res.error, endpoint: resolveEndpoint(cfg.baseUrl) })
    return c.json({
      ok: true,
      latency_ms: res.data.latencyMs,
      sample: res.data.sample,
      endpoint: resolveEndpoint(cfg.baseUrl),
    })
  })
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

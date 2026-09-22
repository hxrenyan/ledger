import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { signAdminToken } from '../auth/jwt.ts'
import { badRequest, notFound, unauthorized } from '../http.ts'

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

  app.get('/api/v1/admin/ledgers', async (c) => {
    const rows = await c.get('db').all<{
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
}

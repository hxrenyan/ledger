import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, forbidden, notFound } from '../http.ts'
import { ledgerOnlyStmts, randomInviteCode } from '../seed.ts'

export function registerLedgerRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/ledgers', async (c) => {
    const rows = await c.get('db').all<{ id: string; name: string; role: string }>(
      `SELECT l.id, l.name, m.role
       FROM members m JOIN ledgers l ON l.id = m.ledger_id
       WHERE m.user_id = ?
       ORDER BY l.created_at ASC`,
      [c.get('userId')],
    )
    return c.json({ items: rows })
  })

  app.post('/api/v1/ledgers', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 32) throw badRequest('账本名称须为 1–32 字')
    const userId = c.get('userId')
    const { stmts, ledgerId } = ledgerOnlyStmts({ userId, name, now: Date.now() })
    await c.get('db').batch(stmts)
    return c.json({ id: ledgerId, name, role: 'owner' }, 201)
  })

  app.post('/api/v1/ledgers/join', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
    if (!code) throw badRequest('请填写邀请码')
    const db = c.get('db')
    const ledger = await db.first<{ id: string; name: string }>(
      `SELECT id, name FROM ledgers WHERE invite_code = ?`,
      [code],
    )
    if (!ledger) throw notFound('邀请码无效')
    const userId = c.get('userId')
    const exists = await db.first<{ role: string }>(
      `SELECT role FROM members WHERE ledger_id = ? AND user_id = ?`,
      [ledger.id, userId],
    )
    if (exists) return c.json({ id: ledger.id, name: ledger.name, role: exists.role })
    await db.run(
      `INSERT INTO members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
      [ledger.id, userId, Date.now()],
    )
    return c.json({ id: ledger.id, name: ledger.name, role: 'member' }, 201)
  })

  app.patch('/api/v1/ledger', async (c) => {
    requireOwner(c.get('memberRole'))
    const body = await c.req.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 32) throw badRequest('账本名称须为 1–32 字')
    await c.get('db').run(`UPDATE ledgers SET name = ? WHERE id = ?`, [name, c.get('ledgerId')])
    return c.json({ id: c.get('ledgerId'), name })
  })

  app.get('/api/v1/members', async (c) => {
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const items = await db.all<{ user_id: string; role: string; username: string; nickname: string }>(
      `SELECT m.user_id, m.role, u.username, u.nickname
       FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.ledger_id = ?
       ORDER BY m.created_at ASC`,
      [ledgerId],
    )
    const ledger = await db.first<{ invite_code: string | null; name: string }>(
      `SELECT invite_code, name FROM ledgers WHERE id = ?`,
      [ledgerId],
    )
    return c.json({
      name: ledger?.name ?? '',
      invite_code: c.get('memberRole') === 'owner' ? ledger?.invite_code ?? null : null,
      items,
    })
  })

  app.post('/api/v1/invite/rotate', async (c) => {
    requireOwner(c.get('memberRole'))
    const code = randomInviteCode()
    await c.get('db').run(`UPDATE ledgers SET invite_code = ? WHERE id = ?`, [code, c.get('ledgerId')])
    return c.json({ invite_code: code })
  })

  app.delete('/api/v1/members/:userId', async (c) => {
    requireOwner(c.get('memberRole'))
    const target = c.req.param('userId')
    if (target === c.get('userId')) throw badRequest('不能移除自己')
    const row = await c.get('db').first(
      `SELECT role FROM members WHERE ledger_id = ? AND user_id = ?`,
      [c.get('ledgerId'), target],
    )
    if (!row) throw notFound('成员不存在')
    await c.get('db').run(
      `DELETE FROM members WHERE ledger_id = ? AND user_id = ?`,
      [c.get('ledgerId'), target],
    )
    return c.json({ ok: true })
  })
}

function requireOwner(role: string) {
  if (role !== 'owner') throw forbidden('仅账本主可以操作')
}

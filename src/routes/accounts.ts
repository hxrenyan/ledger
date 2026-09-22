import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, notFound } from '../http.ts'
import { newId } from '../seed.ts'

const TYPES = new Set(['cash', 'bank', 'alipay', 'wechat', 'credit', 'other'])

type AccountRow = {
  id: string
  name: string
  type: string
  sort_order: number
  archived: number
  current_cents: number
}

export function registerAccountRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/accounts', async (c) => {
    const rows = await c.get('db').all<AccountRow>(
      `SELECT id, name, type, sort_order, archived, current_cents FROM accounts
       WHERE ledger_id = ? ORDER BY sort_order ASC, created_at ASC`,
      [c.get('ledgerId')],
    )
    const items = rows.map(shape)
    const net = items.filter((a) => !a.archived).reduce((s, a) => s + a.current_cents, 0)
    return c.json({ items, net_cents: net })
  })

  app.post('/api/v1/accounts', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const name = assertName(body.name)
    const type = typeof body.type === 'string' && TYPES.has(body.type) ? body.type : 'other'
    const current = parseCents(body.current_cents)
    const id = newId()
    const now = Date.now()
    await c.get('db').run(
      `INSERT INTO accounts (id, ledger_id, name, type, sort_order, archived, current_cents, created_at)
       VALUES (?, ?, ?, ?, 100, 0, ?, ?)`,
      [id, c.get('ledgerId'), name, type, current, now],
    )
    return c.json({ id, name, type, sort_order: 100, archived: false, current_cents: current }, 201)
  })

  app.patch('/api/v1/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const db = c.get('db')
    const row = await db.first<AccountRow>(
      `SELECT id, name, type, sort_order, archived, current_cents FROM accounts WHERE id = ? AND ledger_id = ?`,
      [id, c.get('ledgerId')],
    )
    if (!row) throw notFound('账户不存在')
    const body = await c.req.json().catch(() => ({}))
    const name = body.name != null ? assertName(body.name) : row.name
    const type = body.type != null ? (TYPES.has(body.type) ? body.type : row.type) : row.type
    const archived = body.archived != null ? (body.archived ? 1 : 0) : row.archived
    const current = body.current_cents != null ? parseCents(body.current_cents) : row.current_cents
    await db.run(
      `UPDATE accounts SET name = ?, type = ?, archived = ?, current_cents = ? WHERE id = ?`,
      [name, type, archived, current, id],
    )
    return c.json({ id, name, type, sort_order: row.sort_order, archived: !!archived, current_cents: current })
  })
}

function shape(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sort_order: row.sort_order,
    archived: !!row.archived,
    current_cents: Number(row.current_cents) || 0,
  }
}

function assertName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 32) {
    throw badRequest('账户名须为 1–32 字')
  }
  return raw.trim()
}

function parseCents(raw: unknown): number {
  if (raw == null || raw === '') return 0
  if (typeof raw !== 'number' || !Number.isInteger(raw) || Math.abs(raw) > 1e12) {
    throw badRequest('余额须为整数分')
  }
  return raw
}

import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { balanceStmts } from '../balance.ts'
import { badRequest, notFound } from '../http.ts'
import { routeId } from '../id.ts'
import { assertAmountCents } from '../money.ts'
import { dateToOccurredAt, nextMonthSameDay, shanghaiDate } from '../time.ts'

export function registerRecurrenceRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/recurrences', async (c) => {
    const rows = await c.get('db').all(
      `SELECT id, kind, amount_cents, account_id, category_id, note, day_of_month, next_at, enabled
       FROM recurrences WHERE ledger_id = ? ORDER BY day_of_month ASC`,
      [c.get('ledgerId')],
    )
    return c.json({ items: rows })
  })

  app.post('/api/v1/recurrences', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const kind = body.kind === 'income' || body.kind === 'expense' ? body.kind : null
    if (!kind) throw badRequest('周期记账仅支持收入或支出')
    const amount = assertAmountCents(body.amount_cents)
    const accountId = routeId(body.account_id, '账户')
    const categoryId = routeId(body.category_id, '分类')
    const day = Number(body.day_of_month)
    if (!Number.isInteger(day) || day < 1 || day > 28) throw badRequest('日期须为 1–28')
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
    const ymd = shanghaiDate()
    const [y, m] = ymd.split('-')
    const thisMonth = `${y}-${m}-${String(day).padStart(2, '0')}`
    let nextAt = dateToOccurredAt(thisMonth)
    if (nextAt < Date.now() - 12 * 3600 * 1000) nextAt = nextMonthSameDay(nextAt)
    const created = await c.get('db').first<{ id: number }>(
      `INSERT INTO recurrences (ledger_id, kind, amount_cents, account_id, category_id, note, day_of_month, next_at, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) RETURNING id`,
      [c.get('ledgerId'), kind, amount, accountId, categoryId, note, day, nextAt, Date.now()],
    )
    if (!created) throw new Error('周期记账创建失败')
    return c.json({ id: created.id, kind, amount_cents: amount, account_id: accountId, category_id: categoryId, note, day_of_month: day, next_at: nextAt, enabled: true }, 201)
  })

  app.patch('/api/v1/recurrences/:id', async (c) => {
    const db = c.get('db')
    const id = routeId(c.req.param('id'), '周期')
    const row = await db.first<{ id: number }>(
      `SELECT id FROM recurrences WHERE id = ? AND ledger_id = ?`,
      [id, c.get('ledgerId')],
    )
    if (!row) throw notFound('周期不存在')
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.enabled === 'boolean') {
      await db.run(`UPDATE recurrences SET enabled = ? WHERE id = ?`, [body.enabled ? 1 : 0, row.id])
    }
    return c.json({ ok: true })
  })

  app.delete('/api/v1/recurrences/:id', async (c) => {
    await c.get('db').run(
      `DELETE FROM recurrences WHERE id = ? AND ledger_id = ?`,
      [routeId(c.req.param('id'), '周期'), c.get('ledgerId')],
    )
    return c.json({ ok: true })
  })

  app.post('/api/v1/recurrences/run', async (c) => {
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const userId = c.get('userId')
    const due = await db.all<{
      id: number
      kind: string
      amount_cents: number
      account_id: number
      category_id: number
      note: string
      next_at: number
    }>(
      `SELECT id, kind, amount_cents, account_id, category_id, note, next_at
       FROM recurrences WHERE ledger_id = ? AND enabled = 1 AND next_at <= ?`,
      [ledgerId, Date.now()],
    )
    let created = 0
    for (const r of due) {
      const now = Date.now()
      await db.batch([
        {
          sql: `INSERT INTO transactions
            (ledger_id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_by, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
          params: [ledgerId, r.account_id, r.category_id, r.kind, r.amount_cents, r.next_at, r.note || '周期记账', userId, now, now],
        },
        ...balanceStmts(
          { kind: r.kind, amount_cents: r.amount_cents, account_id: r.account_id, to_account_id: null },
          1,
        ),
        {
          sql: `UPDATE recurrences SET next_at = ? WHERE id = ?`,
          params: [nextMonthSameDay(r.next_at), r.id],
        },
      ])
      created += 1
    }
    return c.json({ created })
  })
}

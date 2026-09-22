import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, notFound } from '../http.ts'
import { assertAmountCents } from '../money.ts'
import { shanghaiMonth } from '../time.ts'
import { newId } from '../seed.ts'

export function registerBudgetRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/budgets', async (c) => {
    const month = c.req.query('month') || shanghaiMonth()
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('月份格式应为 YYYY-MM')
    const rows = await c.get('db').all<{
      id: string
      category_id: string
      amount_cents: number
    }>(
      `SELECT id, category_id, amount_cents FROM budgets WHERE ledger_id = ? AND month = ?`,
      [c.get('ledgerId'), month],
    )
    return c.json({
      month,
      items: rows.map((r) => ({
        id: r.id,
        category_id: r.category_id || null,
        amount_cents: r.amount_cents,
      })),
    })
  })

  app.put('/api/v1/budgets', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const month = typeof body.month === 'string' ? body.month : shanghaiMonth()
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('月份格式应为 YYYY-MM')
    const amount = assertAmountCents(body.amount_cents)
    const categoryId = typeof body.category_id === 'string' ? body.category_id : ''
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    if (categoryId) {
      const cat = await db.first(
        `SELECT id FROM categories WHERE id = ? AND ledger_id = ? AND kind = 'expense'`,
        [categoryId, ledgerId],
      )
      if (!cat) throw badRequest('只能给支出分类设预算')
    }
    const existing = await db.first<{ id: string }>(
      `SELECT id FROM budgets WHERE ledger_id = ? AND month = ? AND category_id = ?`,
      [ledgerId, month, categoryId],
    )
    if (existing) {
      await db.run(`UPDATE budgets SET amount_cents = ? WHERE id = ?`, [amount, existing.id])
      return c.json({ id: existing.id, category_id: categoryId || null, amount_cents: amount, month })
    }
    const id = newId()
    await db.run(
      `INSERT INTO budgets (id, ledger_id, category_id, month, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, ledgerId, categoryId, month, amount, Date.now()],
    )
    return c.json({ id, category_id: categoryId || null, amount_cents: amount, month }, 201)
  })

  app.delete('/api/v1/budgets/:id', async (c) => {
    const row = await c.get('db').first(
      `SELECT id FROM budgets WHERE id = ? AND ledger_id = ?`,
      [c.req.param('id'), c.get('ledgerId')],
    )
    if (!row) throw notFound('预算不存在')
    await c.get('db').run(`DELETE FROM budgets WHERE id = ?`, [c.req.param('id')])
    return c.json({ ok: true })
  })
}

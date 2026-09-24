import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { addMonth, shanghaiMonth, shanghaiMonthRange, shanghaiYearRange } from '../time.ts'

const STAT = `kind IN ('income', 'expense') AND IFNULL(excluded, 0) = 0`
const STAT_T = `t.kind IN ('income', 'expense') AND IFNULL(t.excluded, 0) = 0`

export function registerStatsRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/stats/monthly', async (c) => {
    const month = c.req.query('month') || shanghaiMonth()
    const { start, end } = shanghaiMonthRange(month)
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const { income_cents, expense_cents, by_category, budget_cents, budget_used_cents } = await monthStats(
      db,
      ledgerId,
      month,
      start,
      end,
    )
    return c.json({
      month,
      income_cents,
      expense_cents,
      net_cents: income_cents - expense_cents,
      budget_cents,
      budget_used_cents,
      by_category,
    })
  })

  app.get('/api/v1/stats/overview', async (c) => {
    const month = c.req.query('month') || shanghaiMonth()
    const year = Number((c.req.query('year') || month.slice(0, 4)))
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const { start, end } = shanghaiMonthRange(month)
    const monthly = await monthStats(db, ledgerId, month, start, end)
    const yr = shanghaiYearRange(year)
    const yearTotals = await db.all<{ kind: string; total: number }>(
      `SELECT kind, SUM(amount_cents) AS total FROM transactions
       WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ? AND ${STAT}
       GROUP BY kind`,
      [ledgerId, yr.start, yr.end],
    )
    let year_income = 0
    let year_expense = 0
    for (const t of yearTotals) {
      if (t.kind === 'income') year_income = Number(t.total) || 0
      if (t.kind === 'expense') year_expense = Number(t.total) || 0
    }
    const trend: { month: string; income_cents: number; expense_cents: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const m = addMonth(month, -i)
      const r = shanghaiMonthRange(m)
      const rows = await db.all<{ kind: string; total: number }>(
        `SELECT kind, SUM(amount_cents) AS total FROM transactions
         WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ? AND ${STAT}
         GROUP BY kind`,
        [ledgerId, r.start, r.end],
      )
      const rec = { month: m, income_cents: 0, expense_cents: 0 }
      for (const t of rows) {
        if (t.kind === 'income') rec.income_cents = Number(t.total) || 0
        if (t.kind === 'expense') rec.expense_cents = Number(t.total) || 0
      }
      trend.push(rec)
    }
    const net = await db.first<{ n: number }>(
      `SELECT COALESCE(SUM(current_cents), 0) AS n FROM accounts WHERE ledger_id = ? AND archived = 0`,
      [ledgerId],
    )
    return c.json({
      month,
      year,
      ...monthly,
      net_cents: monthly.income_cents - monthly.expense_cents,
      year_income_cents: year_income,
      year_expense_cents: year_expense,
      year_net_cents: year_income - year_expense,
      trend,
      net_worth_cents: Number(net?.n) || 0,
    })
  })
}

async function monthStats(
  db: AppEnv['Variables']['db'],
  ledgerId: number,
  month: string,
  start: number,
  end: number,
) {
  const totals = await db.all<{ kind: string; total: number }>(
    `SELECT kind, SUM(amount_cents) AS total
     FROM transactions
     WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ? AND ${STAT}
     GROUP BY kind`,
    [ledgerId, start, end],
  )
  let income_cents = 0
  let expense_cents = 0
  for (const t of totals) {
    if (t.kind === 'income') income_cents = Number(t.total) || 0
    if (t.kind === 'expense') expense_cents = Number(t.total) || 0
  }
  const byCategory = await db.all<{ category_id: number; name: string; kind: string; total: number }>(
    `SELECT t.category_id, c.name, t.kind, SUM(t.amount_cents) AS total
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     WHERE t.ledger_id = ? AND t.occurred_at >= ? AND t.occurred_at < ? AND ${STAT_T}
     GROUP BY t.category_id, c.name, t.kind
     ORDER BY total DESC`,
    [ledgerId, start, end],
  )
  const budgets = await db.all<{ category_id: number; amount_cents: number }>(
    `SELECT category_id, amount_cents FROM budgets WHERE ledger_id = ? AND month = ?`,
    [ledgerId, month],
  )
  const budgetMap = new Map(budgets.map((b) => [b.category_id, b.amount_cents]))
  return {
    income_cents,
    expense_cents,
    budget_cents: budgetMap.get(0) ?? 0,
    budget_used_cents: expense_cents,
    by_category: byCategory.map((r) => ({
      category_id: r.category_id,
      name: r.name,
      kind: r.kind,
      amount_cents: Number(r.total) || 0,
      budget_cents: r.kind === 'expense' ? budgetMap.get(r.category_id) ?? 0 : 0,
    })),
  }
}

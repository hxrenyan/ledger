import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, notFound } from '../http.ts'
import { newId } from '../seed.ts'

type CatRow = {
  id: string
  name: string
  kind: string
  sort_order: number
  archived: number
}

export function registerCategoryRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/categories', async (c) => {
    const rows = await c.get('db').all<CatRow>(
      `SELECT id, name, kind, sort_order, archived FROM categories
       WHERE ledger_id = ? ORDER BY kind ASC, sort_order ASC, created_at ASC`,
      [c.get('ledgerId')],
    )
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        sort_order: r.sort_order,
        archived: !!r.archived,
      })),
    })
  })

  app.post('/api/v1/categories', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const name = assertName(body.name)
    const kind = body.kind === 'income' ? 'income' : body.kind === 'expense' ? 'expense' : null
    if (!kind) throw badRequest('分类类型须为 expense 或 income')
    const id = newId()
    const now = Date.now()
    await c.get('db').run(
      `INSERT INTO categories (id, ledger_id, name, kind, sort_order, archived, created_at)
       VALUES (?, ?, ?, ?, 100, 0, ?)`,
      [id, c.get('ledgerId'), name, kind, now],
    )
    return c.json({ id, name, kind, sort_order: 100, archived: false }, 201)
  })

  app.patch('/api/v1/categories/:id', async (c) => {
    const id = c.req.param('id')
    const db = c.get('db')
    const row = await db.first<CatRow>(
      `SELECT id, name, kind, sort_order, archived FROM categories WHERE id = ? AND ledger_id = ?`,
      [id, c.get('ledgerId')],
    )
    if (!row) throw notFound('分类不存在')
    const body = await c.req.json().catch(() => ({}))
    const name = body.name != null ? assertName(body.name) : row.name
    const archived = body.archived != null ? (body.archived ? 1 : 0) : row.archived
    await db.run(`UPDATE categories SET name = ?, archived = ? WHERE id = ?`, [name, archived, id])
    return c.json({
      id,
      name,
      kind: row.kind,
      sort_order: row.sort_order,
      archived: !!archived,
    })
  })
}

function assertName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 32) {
    throw badRequest('分类名须为 1–32 字')
  }
  return raw.trim()
}

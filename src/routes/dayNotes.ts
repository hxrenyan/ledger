import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, notFound } from '../http.ts'
import { routeId } from '../id.ts'
import { addYears } from '../time.ts'

/** 一条记事的正文上限。按字符数算，空格先去掉。 */
const BODY_MAX = 200

type NoteRow = {
  id: number
  day: string
  body: string
  created_at: number
  updated_at: number
}

/**
 * 个人日历记事。请求仍要带当前账本，中间件据此确认这个人进得了工具；
 * 记事本身只按 user_id 读写，换账本内容不变。
 */
export function registerDayNoteRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/day-notes', async (c) => {
    c.header('Cache-Control', 'no-store')
    const month = c.req.query('month') ?? ''
    const day = c.req.query('day') ?? ''
    const from = c.req.query('from') ?? ''
    const to = c.req.query('to') ?? ''
    const hasRange = Boolean(from || to)
    const modes = [Boolean(month), Boolean(day), hasRange].filter(Boolean).length
    if (modes > 1) throw badRequest('月份、日期和时间范围只能指定一个')
    if ((from && !to) || (!from && to)) throw badRequest('请同时指定开始和结束日期')
    const db = c.get('db')
    const userId = c.get('userId')
    if (month) {
      const value = parseMonth(month)
      const items = await db.all<NoteRow>(
        `SELECT id, day, body, created_at, updated_at
         FROM day_notes
         WHERE user_id = ? AND day >= ? AND day < ?
         ORDER BY day ASC, created_at ASC, id ASC`,
        [userId, `${value}-01`, monthStartAfter(value)],
      )
      const counts = new Map<string, number>()
      for (const item of items) {
        counts.set(item.day, (counts.get(item.day) ?? 0) + 1)
      }
      const days = Array.from(counts.entries()).map(([d, count]) => ({ day: d, count }))
      return c.json({
        month: value,
        days,
        items,
      })
    }
    if (day) {
      const value = parseDay(day)
      const items = await db.all<NoteRow>(
        `SELECT id, day, body, created_at, updated_at
         FROM day_notes
         WHERE user_id = ? AND day = ?
         ORDER BY created_at ASC, id ASC`,
        [userId, value],
      )
      return c.json({ day: value, items })
    }
    if (from && to) {
      const start = parseDay(from)
      const end = parseDay(to)
      if (start > end) throw badRequest('开始日期不能晚于结束日期')
      if (end > addYears(start, 1)) throw badRequest('时间范围不能超过一年')
      const items = await db.all<NoteRow>(
        `SELECT id, day, body, created_at, updated_at
         FROM day_notes
         WHERE user_id = ? AND day >= ? AND day <= ?
         ORDER BY day ASC, created_at ASC, id ASC`,
        [userId, start, end],
      )
      const counts = new Map<string, number>()
      for (const item of items) {
        counts.set(item.day, (counts.get(item.day) ?? 0) + 1)
      }
      const days = Array.from(counts.entries()).map(([d, count]) => ({ day: d, count }))
      return c.json({ from: start, to: end, days, items })
    }
    throw badRequest('请指定月份、日期或时间范围')
  })

  app.post('/api/v1/day-notes', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const day = parseDay(body.day)
    const text = parseBody(body.body)
    const userId = c.get('userId')
    const now = Date.now()
    const inserted = await c.get('db').batch([
      {
        sql: `INSERT INTO day_notes (user_id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        params: [userId, day, text, now, now],
      },
    ])
    const id = inserted[0]?.lastId
    if (id == null) throw new Error('记事写入失败')
    const row = await c.get('db').first<NoteRow>(
      `SELECT id, day, body, created_at, updated_at FROM day_notes WHERE id = ? AND user_id = ?`,
      [id, userId],
    )
    if (!row) throw new Error('记事写入失败')
    return c.json(row, 201)
  })

  app.patch('/api/v1/day-notes/:id', async (c) => {
    const id = routeId(c.req.param('id'), '记事')
    const body = await c.req.json().catch(() => ({}))
    const text = parseBody(body.body)
    const db = c.get('db')
    const userId = c.get('userId')
    const existing = await db.first<{ id: number }>(
      `SELECT id FROM day_notes WHERE id = ? AND user_id = ?`,
      [id, userId],
    )
    if (!existing) throw notFound('记事不存在')
    const now = Date.now()
    await db.run(`UPDATE day_notes SET body = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [
      text,
      now,
      id,
      userId,
    ])
    const row = await db.first<NoteRow>(
      `SELECT id, day, body, created_at, updated_at FROM day_notes WHERE id = ? AND user_id = ?`,
      [id, userId],
    )
    if (!row) throw notFound('记事不存在')
    return c.json(row)
  })

  app.delete('/api/v1/day-notes/:id', async (c) => {
    const id = routeId(c.req.param('id'), '记事')
    const db = c.get('db')
    const userId = c.get('userId')
    const existing = await db.first<{ id: number }>(
      `SELECT id FROM day_notes WHERE id = ? AND user_id = ?`,
      [id, userId],
    )
    if (!existing) throw notFound('记事不存在')
    await db.run(`DELETE FROM day_notes WHERE id = ? AND user_id = ?`, [id, userId])
    return c.json({ ok: true })
  })
}

function parseMonth(raw: string): string {
  if (!/^\d{4}-\d{2}$/.test(raw)) throw badRequest('月份格式应为 YYYY-MM')
  const month = Number(raw.slice(5, 7))
  if (month < 1 || month > 12) throw badRequest('月份格式应为 YYYY-MM')
  return raw
}

function parseDay(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest('日期格式应为 YYYY-MM-DD')
  const [y, m, d] = raw.split('-').map(Number)
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== (m ?? 0) - 1 || date.getUTCDate() !== d) {
    throw badRequest('日期无效')
  }
  return raw
}

/** 下个月 1 日，作为本月日期范围的右边界。 */
function monthStartAfter(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 0, m ?? 1, 1))
  const year = date.getUTCFullYear()
  const next = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${next}-01`
}

function parseBody(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('正文须为 1–200 字')
  const text = raw.trim()
  const length = [...text].length
  if (length < 1 || length > BODY_MAX) throw badRequest('正文须为 1–200 字')
  return text
}

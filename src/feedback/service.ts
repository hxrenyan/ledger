import type { Db } from '../db/types.ts'
import { badRequest, notFound } from '../http.ts'
import { shanghaiDate } from '../time.ts'

const CONTENT_MAX = 500
const CONTACT_MAX = 40
const REPLY_MAX = 500
const DAILY_LIMIT = 10

export type FeedbackStatus = 'open' | 'done'

export type FeedbackItem = {
  id: number
  content: string
  contact: string
  status: FeedbackStatus
  status_label: string
  reply: string
  created_at: number
  updated_at: number
  time: string
}

export type AdminFeedbackItem = FeedbackItem & {
  user_id: number
  username: string
  nickname: string
}

type FeedbackRow = {
  id: number
  user_id: number
  content: string
  contact: string
  status: string
  reply: string
  created_at: number
  updated_at: number
  username?: string | null
  nickname?: string | null
}

/** 提交一条反馈。同一用户每个上海日最多 10 条，避免刷屏。 */
export async function createFeedback(db: Db, userId: number, contentRaw: string, contactRaw: string) {
  const content = contentRaw.trim()
  const contact = contactRaw.trim()
  if (!content || content.length > CONTENT_MAX) throw badRequest(`反馈内容须为 1–${CONTENT_MAX} 字`)
  if (contact.length > CONTACT_MAX) throw badRequest(`联系方式最多 ${CONTACT_MAX} 字`)
  const now = Date.now()
  const range = shanghaiDayRange(now)
  const used = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM feedbacks WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    [userId, range.start, range.end],
  )
  if (Number(used?.n ?? 0) >= DAILY_LIMIT) throw badRequest('今天已经提交 10 条，明天再写')
  const written = await db.batch([
    {
      sql: `INSERT INTO feedbacks (user_id, content, contact, status, reply, created_at, updated_at)
            VALUES (?, ?, ?, 'open', '', ?, ?)`,
      params: [userId, content, contact, now, now],
    },
  ])
  const id = written[0]?.lastId
  if (id == null) throw badRequest('提交失败，请重试')
  const row = await db.first<FeedbackRow>(
    `SELECT id, user_id, content, contact, status, reply, created_at, updated_at FROM feedbacks WHERE id = ?`,
    [id],
  )
  if (!row) throw badRequest('提交失败，请重试')
  return toItem(row)
}

export async function listOwnFeedback(db: Db, userId: number): Promise<FeedbackItem[]> {
  const rows = await db.all<FeedbackRow>(
    `SELECT id, user_id, content, contact, status, reply, created_at, updated_at
     FROM feedbacks
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [userId],
  )
  return rows.map(toItem)
}

export async function listAdminFeedback(db: Db, status: FeedbackStatus | 'all'): Promise<AdminFeedbackItem[]> {
  const filtered = status !== 'all'
  const rows = await db.all<FeedbackRow>(
    `SELECT f.id, f.user_id, f.content, f.contact, f.status, f.reply, f.created_at, f.updated_at,
            u.username, u.nickname
     FROM feedbacks f
     LEFT JOIN users u ON u.id = f.user_id
     ${filtered ? 'WHERE f.status = ?' : ''}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT 100`,
    filtered ? [status] : [],
  )
  return rows.map((row) => ({
    ...toItem(row),
    user_id: Number(row.user_id),
    username: row.username ?? '',
    nickname: row.nickname ?? '',
  }))
}

export async function updateFeedback(db: Db, id: number, status: FeedbackStatus | undefined, reply: string | undefined) {
  if (status == null && reply == null) throw badRequest('请填写处理结果')
  const existing = await db.first<FeedbackRow>(
    `SELECT id, user_id, content, contact, status, reply, created_at, updated_at FROM feedbacks WHERE id = ?`,
    [id],
  )
  if (!existing) throw notFound('反馈不存在')
  const nextStatus = status ?? (existing.status === 'done' ? 'done' : 'open')
  const nextReply = reply ?? existing.reply
  const now = Date.now()
  await db.run(`UPDATE feedbacks SET status = ?, reply = ?, updated_at = ? WHERE id = ?`, [nextStatus, nextReply, now, id])
  return {
    ...toItem({ ...existing, status: nextStatus, reply: nextReply, updated_at: now }),
    user_id: Number(existing.user_id),
  }
}

export function parseFeedbackStatus(raw: unknown): FeedbackStatus | 'all' | null {
  if (raw === 'open' || raw === 'done' || raw === 'all') return raw
  return null
}

function toItem(row: FeedbackRow): FeedbackItem {
  const status: FeedbackStatus = row.status === 'done' ? 'done' : 'open'
  return {
    id: Number(row.id),
    content: row.content,
    contact: row.contact,
    status,
    status_label: status === 'done' ? '已处理' : '待处理',
    reply: row.reply,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    time: shanghaiClock(row.created_at),
  }
}

/** 上海当日 [start, end)。00:00 对应 UTC 前一天 16:00。 */
function shanghaiDayRange(ms: number) {
  const day = shanghaiDate(ms)
  const [year, month, date] = day.split('-').map(Number)
  const start = Date.UTC(year, month - 1, date) - 8 * 3600 * 1000
  return { start, end: start + 24 * 3600 * 1000 }
}

function shanghaiClock(ms: number) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

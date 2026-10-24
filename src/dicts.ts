import { parseDateKind } from './calendar/contactDate.ts'
import type { Db } from './db/types.ts'
import { badRequest } from './http.ts'
import { hasDbColumn } from './contacts.ts'

/** 联系人日子标签。名称规则见 parseDateKind。 */
export const CONTACT_DATE_KIND = 'contact_date'

const KIND_RE = /^[a-z][a-z0-9_]{0,31}$/
const NAME_MAX = 32

export type DictItem = {
  id: number
  kind: string
  name: string
  sort_order: number
}

export function assertDictKind(raw: unknown): string {
  if (typeof raw !== 'string' || !KIND_RE.test(raw)) throw badRequest('字典类型须为小写字母、数字或下划线')
  return raw
}

export function assertDictName(kind: string, raw: unknown): string {
  if (kind === CONTACT_DATE_KIND) {
    try {
      return parseDateKind(raw)
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : '日子名称无效')
    }
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > NAME_MAX) {
    throw badRequest(`名称须为 1–${NAME_MAX} 字`)
  }
  return raw.trim()
}

/** 公共项、账号范围及尚未迁移的旧账本范围。 */
export type DictScope = { userId: number } | { ledgerId: number } | null

async function scopeQuery(db: Db, scope: DictScope) {
  const hasUserId = await hasDbColumn(db, 'dict_items', 'user_id')
  if (!hasUserId) {
    if (scope && 'userId' in scope) {
      throw new Error('旧字典表需要账本范围')
    }
    const ledgerId = scope?.ledgerId ?? null
    return {
      sql: ledgerId == null ? 'ledger_id IS NULL' : '(ledger_id IS NULL OR ledger_id = ?)',
      params: ledgerId == null ? [] : [ledgerId],
      order: '(ledger_id IS NULL)',
      hasUserId,
      ledgerId,
      userId: null,
    }
  }
  const userId = scope && 'userId' in scope ? scope.userId : null
  const ledgerId = scope && 'ledgerId' in scope ? scope.ledgerId : null
  const parts = ['(ledger_id IS NULL AND user_id IS NULL)']
  const params: number[] = []
  if (userId != null) {
    parts.push('(user_id = ? AND ledger_id IS NULL)')
    params.push(userId)
  }
  if (ledgerId != null) {
    parts.push('(ledger_id = ? AND user_id IS NULL)')
    params.push(ledgerId)
  }
  return {
    sql: parts.join(' OR '),
    params,
    order: '(ledger_id IS NULL AND user_id IS NULL)',
    hasUserId,
    ledgerId,
    userId,
  }
}

export async function listDictItems(db: Db, scope: DictScope, kind: string): Promise<DictItem[]> {
  const visible = await scopeQuery(db, scope)
  return db.all<DictItem>(
    `SELECT id, kind, name, sort_order FROM dict_items
     WHERE kind = ? AND archived = 0 AND (${visible.sql})
     ORDER BY ${visible.order} DESC, sort_order ASC, id ASC`,
    [kind, ...visible.params],
  )
}

/** 按名称取出字典项，恢复归档项；同名公共项优先。 */
export async function ensureDictItem(db: Db, scope: DictScope, kind: string, name: string): Promise<DictItem> {
  const existing = await findDictItem(db, scope, kind, name)
  if (existing) {
    await db.run(`UPDATE dict_items SET archived = 0 WHERE id = ? AND archived != 0`, [existing.id])
    return existing
  }
  const visible = await scopeQuery(db, scope)
  try {
    const saved = visible.hasUserId
      ? await db.first<DictItem>(
        `INSERT INTO dict_items (ledger_id, user_id, kind, name, sort_order, archived, created_at)
         VALUES (?, ?, ?, ?, 0, 0, ?) RETURNING id, kind, name, sort_order`,
        [visible.ledgerId, visible.userId, kind, name, Date.now()],
      )
      : await db.first<DictItem>(
        `INSERT INTO dict_items (ledger_id, kind, name, sort_order, archived, created_at)
         VALUES (?, ?, ?, 0, 0, ?) RETURNING id, kind, name, sort_order`,
        [visible.ledgerId, kind, name, Date.now()],
      )
    if (saved) return saved
  } catch (err) {
    const again = await findDictItem(db, scope, kind, name)
    if (again) return again
    throw err
  }
  throw new Error('字典项保存失败')
}

async function findDictItem(db: Db, scope: DictScope, kind: string, name: string): Promise<DictItem | null> {
  const visible = await scopeQuery(db, scope)
  return db.first<DictItem>(
    `SELECT id, kind, name, sort_order FROM dict_items
     WHERE kind = ? AND name = ? AND (${visible.sql})
     ORDER BY ${visible.order} DESC, id ASC LIMIT 1`,
    [kind, name, ...visible.params],
  )
}

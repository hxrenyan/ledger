import { parseDateKind } from './calendar/contactDate.ts'
import type { Db } from './db/types.ts'
import { badRequest } from './http.ts'

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

export async function listDictItems(db: Db, ledgerId: number, kind: string): Promise<DictItem[]> {
  return db.all<DictItem>(
    `SELECT id, kind, name, sort_order
     FROM dict_items
     WHERE kind = ? AND archived = 0 AND (ledger_id IS NULL OR ledger_id = ?)
     ORDER BY ledger_id IS NULL DESC, sort_order ASC, id ASC`,
    [kind, ledgerId],
  )
}

/**
 * 按名称取出字典项。已归档的恢复。
 * ledgerId 为空时只匹配公共项。有账本时，同名公共项优先，不再另建一条。
 */
export async function ensureDictItem(
  db: Db,
  ledgerId: number | null,
  kind: string,
  name: string,
): Promise<DictItem> {
  const existing = await findDictItem(db, ledgerId, kind, name)
  if (existing) {
    await db.run(`UPDATE dict_items SET archived = 0 WHERE id = ? AND archived != 0`, [existing.id])
    return existing
  }
  try {
    const saved = await db.first<DictItem>(
      `INSERT INTO dict_items (ledger_id, kind, name, sort_order, archived, created_at)
       VALUES (?, ?, ?, 0, 0, ?)
       RETURNING id, kind, name, sort_order`,
      [ledgerId, kind, name, Date.now()],
    )
    if (saved) return saved
  } catch (err) {
    const again = await findDictItem(db, ledgerId, kind, name)
    if (again) return again
    throw err
  }
  throw new Error('字典项保存失败')
}

async function findDictItem(db: Db, ledgerId: number | null, kind: string, name: string): Promise<DictItem | null> {
  return db.first<DictItem>(
    `SELECT id, kind, name, sort_order
     FROM dict_items
     WHERE kind = ? AND name = ?
       AND (
         (? IS NULL AND ledger_id IS NULL)
         OR (? IS NOT NULL AND (ledger_id IS NULL OR ledger_id = ?))
       )
     ORDER BY ledger_id IS NULL DESC, id ASC
     LIMIT 1`,
    [kind, name, ledgerId, ledgerId, ledgerId],
  )
}

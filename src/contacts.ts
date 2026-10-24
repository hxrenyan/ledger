import type { Db } from './db/types.ts'
import { badRequest } from './http.ts'

export type ContactStorageScope = {
  column: 'ledger_id' | 'user_id'
  id: number
  ledgerId: number
  ownerId: number
  ownerScoped: boolean
}

/** 兼容尚未执行联系人账号范围迁移的旧库。 */
export async function contactStorageScope(db: Db, ledgerId: number): Promise<ContactStorageScope> {
  const ownerId = await ledgerContactOwner(db, ledgerId)
  const columns = await db.all<{ name: string }>('PRAGMA table_info(contacts)')
  const ownerScoped = columns.some((column) => column.name === 'user_id')
  return {
    column: ownerScoped ? 'user_id' : 'ledger_id',
    id: ownerScoped ? ownerId : ledgerId,
    ledgerId,
    ownerId,
    ownerScoped,
  }
}

/** 联系人归账本主人；共享成员的操作也使用这个账号范围。 */
export async function ledgerContactOwner(db: Db, ledgerId: number): Promise<number> {
  const ledger = await db.first<{ owner_id: number }>(`SELECT owner_id FROM ledgers WHERE id = ?`, [ledgerId])
  if (!ledger) throw badRequest('账本不存在')
  return ledger.owner_id
}

export async function hasDbColumn(db: Db, table: 'contacts' | 'contact_dates' | 'dict_items', column: string) {
  const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return columns.some((item) => item.name === column)
}

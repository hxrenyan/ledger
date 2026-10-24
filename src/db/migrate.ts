import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInviteCode } from '../seed.ts'
import type { Db } from './types.ts'
import { grantMissingSignups } from '../points/wallet.ts'
import { upgradeSchema } from './upgrade.ts'
import { hasDbColumn } from '../contacts.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** 启动时套用 sql/schema.sql，并给旧库补列。请求处理函数里不要建表。 */
export async function ensureMigrated(db: Db) {
  const schema = readFileSync(join(root, 'sql/schema.sql'), 'utf8')
  const idx = schema.search(/CREATE (UNIQUE )?INDEX/i)
  let tablesSql = idx >= 0 ? schema.slice(0, idx) : schema
  const indexSql = idx >= 0 ? schema.slice(idx) : ''
  const legacyContacts = await hasDbColumn(db, 'contacts', 'ledger_id')
  if (legacyContacts) {
    // 极旧库可能尚无日子表，按既有联系人范围从权威 schema 补表，不改联系人归属。
    tablesSql = tablesSql.replace(/CREATE TABLE IF NOT EXISTS contact_dates \([\s\S]*?\);/,
      (definition) => definition.replace('user_id INTEGER NOT NULL', 'ledger_id INTEGER NOT NULL'))
  }
  await db.exec(tablesSql)
  const addedBalance = await ensureColumn(db, 'accounts', 'current_cents', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'users', 'last_seen_at', 'INTEGER')
  await ensureColumn(db, 'ledgers', 'invite_code', 'TEXT')
  await ensureColumn(db, 'ledgers', 'last_seen_at', 'INTEGER')
  await ensureColumn(db, 'transactions', 'has_receipt', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'excluded', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'import_batch_id', 'INTEGER')
  await ensureColumn(db, 'point_entries', 'biz_key', 'TEXT')
  const contactOwnerScoped = await hasDbColumn(db, 'contacts', 'user_id')
  const dictOwnerScoped = await hasDbColumn(db, 'dict_items', 'user_id')
  for (const statement of indexSql.split(';')) {
    if (!statement.trim()) continue
    if (!contactOwnerScoped && /idx_(contacts_user|contact_dates_user)/i.test(statement)) continue
    if (!dictOwnerScoped && /idx_dict_items_(user_name|public_name)/i.test(statement)) continue
    await db.exec(statement)
  }
  await backfillInviteCodes(db)
  if (addedBalance) await backfillBalances(db)
  await upgradeSchema(db)
  await grantMissingSignups(db)
}

async function ensureColumn(db: Db, table: string, column: string, def: string): Promise<boolean> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (cols.some((c) => c.name === column)) return false
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
  return true
}

async function backfillInviteCodes(db: Db) {
  const rows = await db.all<{ id: number }>(
    `SELECT id FROM ledgers WHERE invite_code IS NULL OR invite_code = ''`,
  )
  for (const row of rows) {
    await db.run(`UPDATE ledgers SET invite_code = ? WHERE id = ?`, [randomInviteCode(), row.id])
  }
}

async function backfillBalances(db: Db) {
  await db.exec(`
    UPDATE accounts SET current_cents = (
      SELECT COALESCE(SUM(CASE
        WHEN t.kind = 'income' AND t.account_id = accounts.id THEN t.amount_cents
        WHEN t.kind = 'expense' AND t.account_id = accounts.id THEN -t.amount_cents
        WHEN t.kind = 'transfer' AND t.account_id = accounts.id THEN -t.amount_cents
        WHEN t.kind = 'transfer' AND t.to_account_id = accounts.id THEN t.amount_cents
        ELSE 0
      END), 0)
      FROM transactions t
      WHERE t.ledger_id = accounts.ledger_id
    )
  `)
}

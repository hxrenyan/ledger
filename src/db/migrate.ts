import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomInviteCode } from '../seed.ts'
import type { Db } from './types.ts'
import { upgradeSchema } from './upgrade.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** 测试 / Node 兜底：套用 sql/schema.sql，并给旧库补列。Worker 请求路径不跑这个。 */
export async function ensureMigrated(db: Db) {
  const schema = readFileSync(join(root, 'sql/schema.sql'), 'utf8')
  const idx = schema.search(/CREATE (UNIQUE )?INDEX/i)
  const tablesSql = idx >= 0 ? schema.slice(0, idx) : schema
  const indexSql = idx >= 0 ? schema.slice(idx) : ''
  await db.exec(tablesSql)
  const addedBalance = await ensureColumn(db, 'accounts', 'current_cents', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'ledgers', 'invite_code', 'TEXT')
  await ensureColumn(db, 'transactions', 'has_receipt', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'excluded', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'import_batch_id', 'TEXT')
  if (indexSql.trim()) await db.exec(indexSql)
  await backfillInviteCodes(db)
  if (addedBalance) await backfillBalances(db)
  await upgradeSchema(db)
}

async function ensureColumn(db: Db, table: string, column: string, def: string): Promise<boolean> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (cols.some((c) => c.name === column)) return false
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
  return true
}

async function backfillInviteCodes(db: Db) {
  const rows = await db.all<{ id: string }>(
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

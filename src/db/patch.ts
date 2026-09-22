import type { Db } from './types.ts'
import { upgradeSchema } from './upgrade.ts'

/** Worker 里不能读 sql 文件；只做缺列/缺表补丁，避免本地旧库 500。 */
export async function patchSchema(db: Db) {
  await ensureColumn(db, 'accounts', 'current_cents', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'excluded', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'has_receipt', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'import_batch_id', 'TEXT')
  await ensureColumn(db, 'gifts', 'import_batch_id', 'TEXT')
  await db.run(
    `CREATE TABLE IF NOT EXISTS recurrences (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      category_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      day_of_month INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`,
  )
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_recurrences_next ON recurrences (ledger_id, enabled, next_at)`,
  )
  await db.run(
    `CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      source TEXT NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      parsed_rows INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      skipped_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      ai_used INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'done',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    )`,
  )
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_import_batches_ledger ON import_batches (ledger_id, created_at)`,
  )
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_tx_import_batch ON transactions (import_batch_id) WHERE import_batch_id IS NOT NULL`,
  )
  await db.run(
    `CREATE INDEX IF NOT EXISTS idx_gifts_import_batch ON gifts (import_batch_id) WHERE import_batch_id IS NOT NULL`,
  )
  await upgradeSchema(db)
  // 与 sql/schema.sql、sql/migrations/006_user_identities.sql 保持一致。Worker 读不到 sql 文件。
  await db.run(
    `CREATE TABLE IF NOT EXISTS user_identities (
      provider TEXT NOT NULL,
      openid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      unionid TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, openid)
    )`,
  )
  await db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (provider, user_id)`,
  )
}

async function ensureColumn(db: Db, table: string, column: string, def: string) {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.length || cols.some((c) => c.name === column)) return
  await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

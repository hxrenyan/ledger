import type { Db } from './types.ts'

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
      to_account_id TEXT,
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
    `CREATE TABLE IF NOT EXISTS ai_settings (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    )`,
  )
  await db.run(
    `CREATE TABLE IF NOT EXISTS asr_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      protocol TEXT NOT NULL DEFAULT 'openai-audio',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
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
}

async function ensureColumn(db: Db, table: string, column: string, def: string) {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.length || cols.some((c) => c.name === column)) return
  await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

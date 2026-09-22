import type { Db } from './types.ts'

/** Worker 里不能读 sql 文件；只做缺列/缺表补丁，避免本地旧库 500。 */
export async function patchSchema(db: Db) {
  await ensureColumn(db, 'accounts', 'current_cents', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'excluded', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'has_receipt', 'INTEGER NOT NULL DEFAULT 0')
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
}

async function ensureColumn(db: Db, table: string, column: string, def: string) {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.length || cols.some((c) => c.name === column)) return
  await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

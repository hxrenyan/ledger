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
  await ensureScoreInviteIndex(db, schema)
  const addedBalance = await ensureColumn(db, 'accounts', 'current_cents', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'users', 'last_seen_at', 'INTEGER')
  await ensureColumn(db, 'ledgers', 'invite_code', 'TEXT')
  await ensureColumn(db, 'ledgers', 'last_seen_at', 'INTEGER')
  await ensureColumn(db, 'transactions', 'has_receipt', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'excluded', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn(db, 'transactions', 'import_batch_id', 'INTEGER')
  await ensureColumn(db, 'point_entries', 'biz_key', 'TEXT')
  await ensureColumn(db, 'score_entries', 'from_player_id', 'TEXT')
  await ensureColumn(db, 'score_entries', 'from_player_name', 'TEXT')
  await ensureColumn(db, 'score_entries', 'from_score_after', 'INTEGER')
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

async function ensureScoreInviteIndex(db: Db, schema: string) {
  const indexes = await db.all<{ name: string; unique: number; origin: string }>('PRAGMA index_list(score_rooms)')
  let hasLegacyUnique = false
  for (const index of indexes) {
    if (!index.unique || index.origin !== 'u') continue
    const columns = await db.all<{ name: string }>(`PRAGMA index_info("${index.name.replace(/"/g, '""')}")`)
    if (columns.length === 1 && columns[0].name === 'invite_code') { hasLegacyUnique = true; break }
  }
  if (hasLegacyUnique) {
    // 旧 schema 的 invite_code 是全表 UNIQUE；重建仅为移除该约束，保留房间和历史数据。
    const definition = schema.match(/CREATE TABLE IF NOT EXISTS score_rooms\s*\([\s\S]*?\);/)?.[0]
    if (!definition) throw new Error('schema 缺少 score_rooms 定义')
    await db.batch([
      { sql: 'CREATE TEMP TABLE score_rooms_sequence AS SELECT seq FROM sqlite_sequence WHERE name = ? ', params: ['score_rooms'] },
      { sql: 'ALTER TABLE score_rooms RENAME TO score_rooms_before_invite_reuse' },
      { sql: definition },
      { sql: `INSERT INTO score_rooms(id,owner_id,name,state_json,rev,invite_code,invite_token,created_at,last_activity_at,ended_at)
        SELECT id,owner_id,name,state_json,rev,invite_code,invite_token,created_at,last_activity_at,ended_at FROM score_rooms_before_invite_reuse` },
      { sql: 'DROP TABLE score_rooms_before_invite_reuse' },
      { sql: `UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM score_rooms_sequence), 0)) WHERE name = 'score_rooms'` },
      { sql: 'DROP TABLE score_rooms_sequence' },
    ])
  }
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_score_rooms_invite_active ON score_rooms(invite_code) WHERE ended_at IS NULL')
  await db.exec('CREATE INDEX IF NOT EXISTS idx_score_rooms_ended ON score_rooms(ended_at, last_activity_at)')
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

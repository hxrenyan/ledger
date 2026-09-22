import type { Db } from './types.ts'

/**
 * 旧库收成 schema.sql 的形状。新库上全部是空操作。
 * 建表 / 删表分步执行，中断后下次进来能接着做完（users_new、attachments_new 残留会改名回去）。
 * 用 run 而不是 exec：D1 的 exec 会按行切开，多行 DDL 会报 incomplete input。
 */

const AI_PROFILES_DDL = `CREATE TABLE IF NOT EXISTS ai_profiles (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  protocol TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
)`

export async function upgradeSchema(db: Db) {
  await db.run(AI_PROFILES_DDL)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ai_profiles_order ON ai_profiles (kind, sort_order)`)
  await mergeLegacyProfiles(db)
  await rebuildUsers(db)
  await rebuildAttachments(db)
  await dropColumn(db, 'contacts', 'note')
  await dropColumn(db, 'recurrences', 'to_account_id')
}

async function mergeLegacyProfiles(db: Db) {
  if (await tableExists(db, 'ai_settings')) {
    await ensureColumn(db, 'ai_settings', 'name', `TEXT NOT NULL DEFAULT ''`)
    await ensureColumn(db, 'ai_settings', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
    await db.run(
      `INSERT INTO ai_profiles (kind, id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
       SELECT 'llm', id, IFNULL(name, ''), enabled, '', base_url, api_key, model, IFNULL(sort_order, 0), updated_at
       FROM ai_settings
       WHERE NOT EXISTS (SELECT 1 FROM ai_profiles p WHERE p.kind = 'llm' AND p.id = ai_settings.id)`,
    )
    await db.run(`DROP TABLE ai_settings`)
  }
  if (await tableExists(db, 'asr_profiles')) {
    await db.run(
      `INSERT INTO ai_profiles (kind, id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
       SELECT 'asr', id, IFNULL(name, ''), enabled, IFNULL(protocol, 'openai-audio'), base_url, api_key, model,
              IFNULL(sort_order, 0), updated_at
       FROM asr_profiles
       WHERE NOT EXISTS (SELECT 1 FROM ai_profiles p WHERE p.kind = 'asr' AND p.id = asr_profiles.id)`,
    )
    await db.run(`DROP TABLE asr_profiles`)
  }
}

async function rebuildUsers(db: Db) {
  if ((await tableExists(db, 'users_new')) && !(await tableExists(db, 'users'))) {
    await db.run(`ALTER TABLE users_new RENAME TO users`)
    return
  }
  if (!(await tableExists(db, 'users'))) return
  const cols = await columnNames(db, 'users')
  if (!cols.includes('wx_openid') && !cols.includes('wx_unionid')) {
    if (await tableExists(db, 'users_new')) await db.run(`DROP TABLE IF EXISTS users_new`)
    return
  }
  await ensureColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0')
  await db.run(`DROP TABLE IF EXISTS users_new`)
  await db.run(`CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    nickname TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`)
  await db.run(`INSERT INTO users_new (id, username, password_hash, nickname, disabled, created_at)
    SELECT id, username, password_hash, nickname, disabled, created_at FROM users`)
  await db.run(`DROP TABLE users`)
  await db.run(`ALTER TABLE users_new RENAME TO users`)
}

async function rebuildAttachments(db: Db) {
  if ((await tableExists(db, 'attachments_new')) && !(await tableExists(db, 'attachments'))) {
    await db.run(`ALTER TABLE attachments_new RENAME TO attachments`)
    return
  }
  if (!(await tableExists(db, 'attachments'))) return
  const cols = await columnNames(db, 'attachments')
  if (!cols.includes('id') && !cols.includes('size')) {
    if (await tableExists(db, 'attachments_new')) await db.run(`DROP TABLE IF EXISTS attachments_new`)
    return
  }
  await db.run(`DROP TABLE IF EXISTS attachments_new`)
  await db.run(`CREATE TABLE attachments_new (
    transaction_id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  await db.run(`INSERT INTO attachments_new (transaction_id, ledger_id, mime, bytes, created_at)
    SELECT transaction_id, ledger_id, mime, bytes, created_at FROM attachments`)
  await db.run(`DROP TABLE attachments`)
  await db.run(`ALTER TABLE attachments_new RENAME TO attachments`)
}

async function dropColumn(db: Db, table: string, column: string) {
  if (!(await tableExists(db, table))) return
  const cols = await columnNames(db, table)
  if (!cols.includes(column)) return
  await db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

async function ensureColumn(db: Db, table: string, column: string, def: string) {
  const cols = await columnNames(db, table)
  if (!cols.length || cols.includes(column)) return
  await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const row = await db.first<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  )
  return !!row
}

async function columnNames(db: Db, table: string): Promise<string[]> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return cols.map((col) => col.name)
}

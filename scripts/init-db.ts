import { loadEnv } from '../src/env.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

loadEnv()

const dbPath = process.env.DB_PATH ?? './data/ledger.db'
const db = createSqliteDb(dbPath)
await ensureMigrated(db)
console.log(`schema ready: ${dbPath}`)

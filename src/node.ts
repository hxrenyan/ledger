import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { createApp } from './app.ts'
import { ensureMigrated } from './db/migrate.ts'
import { createSqliteDb } from './db/sqlite.ts'

const dbPath = process.env.DB_PATH ?? './data/ledger.db'
const jwtSecret = process.env.JWT_SECRET ?? 'dev-change-me'
const adminToken = process.env.ADMIN_TOKEN ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-admin')
const port = Number(process.env.PORT ?? 3000)

const db = createSqliteDb(dbPath)
await ensureMigrated(db)

const app = createApp({ db, jwtSecret, adminToken })

if (existsSync('public/index.html')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('*', serveStatic({ path: './public/index.html' }))
}

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`ledger api http://127.0.0.1:${info.port}  db=${dbPath}`)
})

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { ensureMigrated } from './db/migrate.ts'
import { createSqliteDb } from './db/sqlite.ts'

const dbPath = process.env.DB_PATH ?? './data/ledger.db'
const jwtSecret = process.env.JWT_SECRET ?? 'dev-change-me'
const adminToken = process.env.ADMIN_TOKEN ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-admin')
const port = Number(process.env.PORT ?? 3000)

const db = createSqliteDb(dbPath)
await ensureMigrated(db)

const app = createApp({
  db,
  jwtSecret,
  adminToken,
  wechatAppId: process.env.WX_APPID,
  wechatAppSecret: process.env.WX_SECRET,
})

/**
 * 微信业务域名校验文件：必须是域名根目录下的纯文本。
 *
 * 这个分支必须放在静态目录之前——下面的 `app.get('*')` 会把任何找不到的路径
 * 兜底成 index.html，校验请求会拿到一坨 HTML，微信校验必然失败。
 * 优先级：环境变量 MP_VERIFY > public/ 下的同名 txt。
 */
app.get('/MP_verify_*', (c) => {
  const text = (process.env.MP_VERIFY ?? '').trim()
  if (text) return c.text(`${text}\n`)
  const name = c.req.path.split('/').pop() ?? ''
  const file = join(process.cwd(), 'public', name)
  if (name && existsSync(file)) return c.text(readFileSync(file, 'utf8'))
  return c.text('未配置业务域名校验文件（MP_VERIFY 未设置，public/ 下也没有同名 txt）\n', 404)
})

if (existsSync('public/index.html')) {
  app.use('/*', serveStatic({ root: './public' }))
  app.get('*', serveStatic({ path: './public/index.html' }))
}

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`ledger api http://127.0.0.1:${info.port}  db=${dbPath}`)
})

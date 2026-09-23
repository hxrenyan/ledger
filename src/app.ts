import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Db } from './db/types.ts'
import { verifyToken } from './auth/jwt.ts'
import { badRequest, forbidden, HttpError, unauthorized } from './http.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerAccountRoutes } from './routes/accounts.ts'
import { registerCategoryRoutes } from './routes/categories.ts'
import { registerTransactionRoutes } from './routes/transactions.ts'
import { registerStatsRoutes } from './routes/stats.ts'
import { registerLedgerRoutes } from './routes/ledgers.ts'
import { registerBudgetRoutes } from './routes/budgets.ts'
import { registerAdminRoutes } from './routes/admin.ts'
import { registerFavorRoutes } from './routes/favors.ts'
import { registerRecurrenceRoutes } from './routes/recurrences.ts'
import { registerImportRoutes } from './routes/imports.ts'
import { registerSpeechRoutes } from './routes/speech.ts'
import { registerOcrRoutes } from './routes/ocr.ts'
import { registerWebviewRoutes } from './routes/webview.ts'
import { resolveWechatExchange, type WechatCodeExchange } from './auth/wechat.ts'

export type AppEnv = {
  Variables: {
    db: Db
    jwtSecret: string
    adminToken: string
    userId: string
    ledgerId: string
    memberRole: string
    isAdmin: boolean
    exchangeWechatCode: WechatCodeExchange | null
  }
}

export type AppConfig = {
  db: Db
  jwtSecret: string
  adminToken?: string
  wechatAppId?: string
  wechatAppSecret?: string
  /** 测试注入。不传则用 wechatAppId / wechatAppSecret 调微信。 */
  exchangeWechatCode?: WechatCodeExchange
}

/**
 * 不要求账本上下文的路径：这些接口要么在选账本之前就要用，要么自己处理账本归属。
 * （webview/handoff 自己校验成员身份，账本无效时不报错、只是不下发账本。）
 */
const LEDGER_OPTIONAL = new Set([
  '/api/v1/me',
  '/api/v1/me/wechat/bind',
  '/api/v1/ledgers',
  '/api/v1/ledgers/join',
  '/api/v1/app/config',
  '/api/v1/webview/handoff',
  // 只读全局的模型配置（ai_profiles），与账本无关。
  // 小程序不带 X-Ledger-Id 调它们，若按「缺账本」挡下来会返回 401，
  // 客户端会把 401 当掉登录，把刚登录的用户踢回登录页。
  '/api/v1/speech/status',
  '/api/v1/ocr/status',
])

export function createApp(cfg: AppConfig) {
  const app = new Hono<AppEnv>()
  const adminToken = cfg.adminToken ?? ''

  app.use('*', async (c, next) => {
    c.set('db', cfg.db)
    c.set('jwtSecret', cfg.jwtSecret)
    c.set('adminToken', adminToken)
    c.set('isAdmin', false)
    c.set('exchangeWechatCode', resolveWechatExchange(cfg))
    await next()
  })

  app.use('/api/*', cors())

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ code: err.code, message: err.message }, err.status as never)
    }
    const msg = err instanceof Error ? err.message : '服务器错误'
    if (
      msg.includes('无效') ||
      msg.includes('须为') ||
      msg.includes('格式') ||
      msg.includes('金额')
    ) {
      return c.json({ code: 'bad_request', message: msg }, 400)
    }
    console.error(err)
    return c.json({ code: 'internal', message: '服务器错误' }, 500)
  })

  app.get('/api/health', (c) => c.json({ ok: true, service: 'ledger' }))

  app.use('/api/v1/*', async (c, next) => {
    const path = c.req.path
    if (path.startsWith('/api/v1/auth/') || path === '/api/v1/admin/login') return next()
    const header = c.req.header('Authorization') ?? ''
    if (!header.startsWith('Bearer ')) throw unauthorized()
    try {
      const payload = await verifyToken(c.get('jwtSecret'), header.slice(7))
      if (payload.admin) {
        if (!path.startsWith('/api/v1/admin')) throw forbidden('管理员令牌不能访问用户接口')
        c.set('isAdmin', true)
        c.set('userId', 'admin')
        return next()
      }
      c.set('userId', payload.sub)
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw unauthorized('登录已过期')
    }
    await next()
  })

  app.use('/api/v1/*', async (c, next) => {
    if (c.get('isAdmin') || c.req.path.startsWith('/api/v1/auth/') || c.req.path === '/api/v1/admin/login') {
      return next()
    }
    const user = await c.get('db').first<{ disabled: number }>(
      `SELECT disabled FROM users WHERE id = ?`,
      [c.get('userId')],
    )
    if (!user) throw unauthorized()
    if (user.disabled) throw unauthorized('账号已停用')
    await next()
  })

  app.use('/api/v1/admin/*', async (c, next) => {
    if (c.req.path === '/api/v1/admin/login') return next()
    if (!c.get('isAdmin')) throw forbidden('需要管理员')
    await next()
  })

  app.use('/api/v1/*', async (c, next) => {
    const path = c.req.path
    if (
      c.get('isAdmin') ||
      path.startsWith('/api/v1/auth/') ||
      path.startsWith('/api/v1/admin') ||
      LEDGER_OPTIONAL.has(path)
    ) {
      return next()
    }
    const userId = c.get('userId')
    const ledgerId = c.req.header('X-Ledger-Id') ?? c.req.query('ledger_id')
    // 用 400 而不是 401：这里用户已经通过鉴权，只是请求没带账本，语义上不是「未登录」。
    // 用 401 会让客户端误判成掉登录，把用户踢回登录页。
    if (!ledgerId) throw badRequest('缺少账本')
    const row = await c.get('db').first<{ role: string }>(
      `SELECT role FROM members WHERE ledger_id = ? AND user_id = ?`,
      [ledgerId, userId],
    )
    if (!row) throw forbidden()
    c.set('ledgerId', ledgerId)
    c.set('memberRole', row.role)
    await next()
  })

  registerAuthRoutes(app)
  registerLedgerRoutes(app)
  registerAccountRoutes(app)
  registerCategoryRoutes(app)
  registerTransactionRoutes(app)
  registerStatsRoutes(app)
  registerBudgetRoutes(app)
  registerFavorRoutes(app)
  registerRecurrenceRoutes(app)
  registerImportRoutes(app)
  registerSpeechRoutes(app)
  registerOcrRoutes(app)
  registerWebviewRoutes(app)
  registerAdminRoutes(app)

  return app
}

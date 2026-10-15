import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { issueHandoff, redeemHandoff } from '../auth/handoff.ts'
import { buildSession } from './auth.ts'

/**
 * 小程序工具页是 web-view，网页里没有 wx.login。
 * 原生先拿一次性交接码，网页再用它换会话。
 */
export function registerWebviewRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/webview/handoff', async (c) => {
    const issued = await issueHandoff(c.get('db'), c.get('userId'), c.get('ledgerId'))
    return c.json(issued)
  })

  app.post('/api/v1/auth/webview-session', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const redeemed = await redeemHandoff(c.get('db'), (body as { code?: unknown }).code)
    const session = await buildSession(c.get('db'), c.get('jwtSecret'), redeemed.user_id, redeemed.ledger_id)
    return c.json(session)
  })
}

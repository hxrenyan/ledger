import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { issueHandoff, redeemHandoff } from '../auth/handoff.ts'
import { readToolsMode } from '../tools/mode.ts'
import { buildSession } from './auth.ts'

/**
 * 网页会话交接，以及「工具」走原生还是 H5。
 * 默认原生。管理后台改成 h5 后，小程序再进「工具」才打开网页，并先要一次性码。
 */
export function registerWebviewRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/app/tools', async (c) => {
    return c.json({ mode: await readToolsMode(c.get('db')) })
  })

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

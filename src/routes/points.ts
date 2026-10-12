import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { checkIn, listPointViews, pointsSummary } from '../points/wallet.ts'

export function registerPointRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/points', async (c) => {
    return c.json(await pointsSummary(c.get('db'), c.get('userId')))
  })

  app.get('/api/v1/points/entries', async (c) => {
    return c.json({ items: await listPointViews(c.get('db'), c.get('userId')) })
  })

  /**
   * 只有小程序进入才发每日积分。网页调用同一地址只返回当前余额，不发放。
   * 发多少由服务端按上海日期决定，请求体里的数字不会被采用。
   */
  app.post('/api/v1/points/check-in', async (c) => {
    const db = c.get('db')
    const userId = c.get('userId')
    const client = (c.req.header('x-ledger-client') || '').trim()
    if (client !== 'miniprogram') {
      const summary = await pointsSummary(db, userId)
      return c.json({ ...summary, granted_daily: 0, granted_streak: 0, message: '' })
    }
    return c.json(await checkIn(db, userId))
  })
}

import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest } from '../http.ts'
import { createFeedback, listOwnFeedback } from '../feedback/service.ts'

export function registerFeedbackRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/feedbacks', async (c) => {
    return c.json({ items: await listOwnFeedback(c.get('db'), c.get('userId')) })
  })

  app.post('/api/v1/feedbacks', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.content !== 'string') throw badRequest('请填写反馈内容')
    const contact = typeof body.contact === 'string' ? body.contact : ''
    const item = await createFeedback(c.get('db'), c.get('userId'), body.content, contact)
    return c.json(item, 201)
  })
}

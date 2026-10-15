import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { assertDictKind, assertDictName, ensureDictItem, listDictItems } from '../dicts.ts'

export function registerDictRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/dicts', async (c) => {
    const kind = assertDictKind(c.req.query('kind'))
    const items = await listDictItems(c.get('db'), c.get('ledgerId'), kind)
    return c.json({ items })
  })

  app.post('/api/v1/dicts', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const kind = assertDictKind(body.kind)
    const name = assertDictName(kind, body.name)
    const ledgerId = body.shared === true ? null : c.get('ledgerId')
    const item = await ensureDictItem(c.get('db'), ledgerId, kind, name)
    return c.json(item)
  })
}

import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { CONTACT_DATE_KIND, assertDictKind, assertDictName, ensureDictItem, listDictItems } from '../dicts.ts'
import { contactStorageScope } from '../contacts.ts'

export function registerDictRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/dicts', async (c) => {
    const kind = assertDictKind(c.req.query('kind'))
    const db = c.get('db')
    const contactScope = kind === CONTACT_DATE_KIND ? await contactStorageScope(db, c.get('ledgerId')) : null
    const scope = contactScope?.ownerScoped ? { userId: contactScope.ownerId } : { ledgerId: c.get('ledgerId') }
    const items = await listDictItems(db, scope, kind)
    return c.json({ items })
  })

  app.post('/api/v1/dicts', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const kind = assertDictKind(body.kind)
    const name = assertDictName(kind, body.name)
    const db = c.get('db')
    const contactScope = kind === CONTACT_DATE_KIND ? await contactStorageScope(db, c.get('ledgerId')) : null
    const scope = body.shared === true ? null
      : contactScope?.ownerScoped ? { userId: contactScope.ownerId } : { ledgerId: c.get('ledgerId') }
    const item = await ensureDictItem(db, scope, kind, name)
    return c.json(item)
  })
}

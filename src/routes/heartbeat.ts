import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { verifyToken } from '../auth/jwt.ts'
import { parseId } from '../id.ts'
import { badRequest, unauthorized } from '../http.ts'
import { effectiveRev, roomState, visible, type Room } from '../score/service.ts'

const KEY = 'app.announcements'
export async function readAnnouncements(db: AppEnv['Variables']['db']) {
  const row = await db.first<{ value: string }>('SELECT value FROM app_configs WHERE key=?', [KEY])
  return row ? JSON.parse(row.value) as { rev: number; items: { id: string; title: string; body: string }[] } : { rev: 0, items: [] }
}
export function registerHeartbeatRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/app/announcements', async (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(await readAnnouncements(c.get('db')))
  })
  app.get('/api/v1/admin/announcements', async (c) => c.json(await readAnnouncements(c.get('db'))))
  app.put('/api/v1/admin/announcements', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { throw badRequest('公告格式无效') }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as { items?: unknown }).items) || (body as { items: unknown[] }).items.length > 10) throw badRequest('最多发布 10 条公告')
    const seen = new Set<string>()
    const items = (body as { items: unknown[] }).items.map((value) => {
      const item = value as Record<string, unknown>
      if (!item || typeof item.id !== 'string' || !/^[\w-]{1,40}$/.test(item.id) || seen.has(item.id) ||
        typeof item.title !== 'string' || !item.title.trim() || item.title.length > 40 || typeof item.body !== 'string' || item.body.length > 500) throw badRequest('公告格式无效')
      seen.add(item.id)
      return { id: item.id, title: item.title.trim(), body: item.body.trim() }
    })
    await c.get('db').batch([{ sql: `INSERT INTO app_configs(key,value,updated_at) VALUES(?,json_object('rev',1,'items',json(?)),?)
      ON CONFLICT(key) DO UPDATE SET value=json_object('rev',json_extract(app_configs.value,'$.rev')+1,'items',json(?)),updated_at=excluded.updated_at`,
      params: [KEY, JSON.stringify(items), Date.now(), JSON.stringify(items)] }])
    return c.json(await readAnnouncements(c.get('db')))
  })
  app.post('/api/v1/app/heartbeat', async (c) => {
    c.header('Cache-Control', 'no-store')
    const db = c.get('db')
    const raw = await c.req.text()
    if (raw.length > 1024) throw badRequest('心跳请求过大')
    let body
    try { body = JSON.parse(raw || '{}') } catch { throw badRequest('心跳格式无效') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('心跳格式无效')
    const subscriptions = body.s ?? {}
    if (!subscriptions || typeof subscriptions !== 'object' || Array.isArray(subscriptions) || Object.keys(subscriptions).length > 8) throw badRequest('订阅无效')
    const entries = Object.entries(subscriptions)
    if (entries.filter(([key]) => key.startsWith('game:')).length > 1) throw badRequest('最多订阅一个记分房间')
    for (const [key, rev] of entries) if ((key !== 'ann' && !/^game:[1-9]\d{0,14}$/.test(key)) || !Number.isSafeInteger(rev) || (rev as number) < 0) throw badRequest('资源或版本无效')
    let userId: number | null = null
    const auth = c.req.header('Authorization')
    if (auth) {
      try {
        if (!auth.startsWith('Bearer ')) throw Error()
        const payload = await verifyToken(c.get('jwtSecret'), auth.slice(7))
        userId = payload.admin ? null : parseId(payload.sub)
        if (!userId) throw Error()
        const user = await db.first<{ disabled: number }>('SELECT disabled FROM users WHERE id=?', [userId])
        if (!user || user.disabled) throw Error()
      } catch { throw unauthorized('登录已过期') }
    }
    const changed: Record<string, number> = {}, unavailable: string[] = []
    for (const [key, rev] of entries) {
      if (key === 'ann') {
        const current = (await readAnnouncements(db)).rev
        if (current !== rev) changed[key] = current
      } else {
        const room = userId ? await db.first<Room>('SELECT * FROM score_rooms WHERE id=?', [Number(key.slice(5))]) : null
        if (!room || !visible(room) || !roomState(room).members.includes(userId!)) unavailable.push(key)
        else if (effectiveRev(room) !== rev) changed[key] = effectiveRev(room)
      }
    }
    return c.json({ ...(Object.keys(changed).length ? { s: changed } : {}), ...(unavailable.length ? { x: unavailable } : {}) })
  })
}

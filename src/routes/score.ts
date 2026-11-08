import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { routeId } from '../id.ts'
import { badRequest, conflict, HttpError } from '../http.ts'
import { transferScore, createRoom, joinRoom, loadRoom, mutateRoom, requireMember, roomView, text,
  ROOM_LIMIT, visible, type Room } from '../score/service.ts'

export function registerScoreRoutes(app: Hono<AppEnv>) {
  app.use('/api/v1/score/*', async (c, next) => {
    if (c.req.method === 'POST' || c.req.method === 'PATCH') {
      const raw = await c.req.text()
      if (raw.length > 8192) throw badRequest('记分请求过大')
      if (raw) {
        let body
        try { body = JSON.parse(raw) } catch { throw badRequest('请求格式无效') }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('请求格式无效')
      }
    }
    await next()
  })
  // 单副本进程内有界限流：短码只能用于加入，不能作为持久访问凭证。
  const joins = new Map<number, { at: number; count: number }>()
  app.get('/api/v1/score/rooms', async (c) => {
    const rows = await c.get('db').all<Room>(`SELECT r.* FROM score_rooms r
      WHERE EXISTS(SELECT 1 FROM json_each(r.state_json,'$.members') m WHERE m.value=?)
      ORDER BY r.created_at DESC`, [c.get('userId')])
    return c.json({ items: rows.filter(visible).map(roomView) })
  })
  app.post('/api/v1/score/rooms', async (c) => c.json(await createRoom(c.get('db'), c.get('userId'), await c.req.json()), 201))
  app.post('/api/v1/score/join', async (c) => {
    const userId = c.get('userId'), now = Date.now()
    if (joins.size > 5000) for (const [key, value] of joins) if (now - value.at > 60000) joins.delete(key)
    const limit = joins.get(userId)
    if (limit && now - limit.at < 60000) {
      if (++limit.count > 12) throw new HttpError(429, 'rate_limit', '加入过于频繁，请稍后重试')
    } else joins.set(userId, { at: now, count: 1 })
    return c.json(await joinRoom(c.get('db'), userId, await c.req.json()))
  })
  app.get('/api/v1/score/rooms/:id', async (c) => c.json(roomView(await loadRoom(c.get('db'), routeId(c.req.param('id'), '房间'), c.get('userId')))))
  app.get('/api/v1/score/rooms/:id/entries', async (c) => {
    const id = routeId(c.req.param('id'), '房间')
    await loadRoom(c.get('db'), id, c.get('userId'))
    const before = c.req.query('before') ? routeId(c.req.query('before'), '游标') : Number.MAX_SAFE_INTEGER
    const limit = Number(c.req.query('limit') || 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw badRequest('分页大小无效')
    const rows = await c.get('db').all<{ id: number }>(`SELECT e.*,COALESCE(NULLIF(TRIM(u.nickname),''),u.username,'未知记录人') AS created_by_name
      FROM score_entries e LEFT JOIN users u ON u.id=e.created_by
      WHERE e.room_id=? AND e.id<? ORDER BY e.id DESC LIMIT ?`, [id, before, limit + 1])
    const items = rows.slice(0, limit)
    return c.json({ items, next: rows.length > limit ? items[items.length - 1].id : null })
  })
  app.post('/api/v1/score/rooms/:id/entries', async (c) => c.json(await transferScore(c.get('db'), routeId(c.req.param('id'), '房间'), c.get('userId'), await c.req.json())))

  const actions = ['players', 'players/:playerId/claim', 'leave', 'end', 'invite/reset']
  for (const action of actions) app.post('/api/v1/score/rooms/:id/' + action, async (c) => {
    const id = routeId(c.req.param('id'), '房间'), userId = c.get('userId')
    const body = action === 'players' ? await c.req.json() : {}
    const playerId = action.includes(':playerId') ? c.req.param('playerId') : ''
    const room = await mutateRoom(c.get('db'), id, userId, (room, state) => {
      requireMember(room, state, userId, ['players', 'end', 'invite/reset'].includes(action))
      if (action === 'players') {
        if (state.players.length >= ROOM_LIMIT) throw conflict('玩家已满 10 人')
        const name = text(body.name)
        if (state.players.some((p) => p.name === name)) throw badRequest('玩家名称不能重复')
        state.players.push({ id: randomBytes(8).toString('hex'), name, score: 0 })
      } else if (action.includes('/claim')) {
        const player = state.players.find((p) => p.id === playerId && !p.disabled)
        if (!player) throw badRequest('玩家不存在或已停用')
        if (player.user_id === userId) return { noop: true }
        if (player.user_id) throw conflict('玩家已被认领')
        if (state.players.some((p) => p.user_id === userId)) throw conflict('你已认领其他玩家')
        player.user_id = userId
      } else if (action === 'leave') {
        if (room.owner_id === userId) throw conflict('房主请先结束记分')
        state.members = state.members.filter((member) => member !== userId)
        state.players.forEach((p) => { if (p.user_id === userId) delete p.user_id })
      }
      return { end: action === 'end', invite: action === 'invite/reset' }
    })
    return c.json(action === 'leave' ? { ok: true } : roomView(room))
  })
  app.delete('/api/v1/score/rooms/:id/players/:playerId', async (c) => {
    const userId = c.get('userId'), id = routeId(c.req.param('id'), '房间'), playerId = c.req.param('playerId')
    const room = await mutateRoom(c.get('db'), id, userId, (room, state) => {
      requireMember(room, state, userId, true)
      const index = state.players.findIndex((player) => player.id === playerId)
      if (index < 0) throw badRequest('玩家不存在')
      if (state.players[index].user_id != null) throw conflict('已有成员认领，不能删除')
      if (state.players[index].score !== 0) throw conflict('玩家仍有未结清分数，转平后才能删除')
      state.players.splice(index, 1)
      return {}
    })
    return c.json(roomView(room))
  })

  app.patch('/api/v1/score/rooms/:id/players/:playerId', async (c) => {
    const body = await c.req.json(), userId = c.get('userId')
    return c.json(roomView(await mutateRoom(c.get('db'), routeId(c.req.param('id'), '房间'), userId, (room, state) => {
      requireMember(room, state, userId, true)
      const player = state.players.find((p) => p.id === c.req.param('playerId'))
      if (!player) throw badRequest('玩家不存在')
      if (body.name !== undefined) {
        const name = text(body.name)
        if (state.players.some((p) => p.id !== player.id && p.name === name)) throw badRequest('玩家名称不能重复')
        player.name = name
      }
      if (body.disabled !== undefined) {
        if (typeof body.disabled !== 'boolean') throw badRequest('停用状态无效')
        player.disabled = body.disabled
      }
      return {}
    })))
  })
}

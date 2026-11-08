import { randomBytes, randomInt } from 'node:crypto'
import { BatchConflict, type Db, type Stmt } from '../db/types.ts'
import { badRequest, conflict, forbidden, notFound } from '../http.ts'

export const IDLE_MS = 24 * 3600 * 1000
export const KEEP_MS = 7 * IDLE_MS
export const ROOM_LIMIT = 10
const SCORE_LIMIT = 1_000_000_000
export type Player = { id: string; name: string; score: number; user_id?: number; disabled?: boolean }
export type State = { members: number[]; players: Player[] }
export type Room = {
  id: number; owner_id: number; name: string; state_json: string; rev: number
  invite_code: string; invite_token: string; created_at: number; last_activity_at: number; ended_at: number | null
}
export type Entry = {
  id: number; room_id: number; player_id: string; player_name: string; delta: number
  score_after: number; created_by: number; request_id: string; created_at: number
  from_player_id?: string | null; from_player_name?: string | null; from_score_after?: number | null
}
export function roomState(room: Room): State { return JSON.parse(room.state_json) }
export function endTime(room: Room) { return room.ended_at ?? (room.last_activity_at + IDLE_MS <= Date.now() ? room.last_activity_at + IDLE_MS : null) }
export function effectiveRev(room: Room) { return room.rev + (room.ended_at === null && endTime(room) !== null ? 1 : 0) }
export function visible(room: Room) { const end = endTime(room); return end === null || end + KEEP_MS > Date.now() }
export function roomView(room: Room) {
  const state = roomState(room)
  return { id: room.id, owner_id: room.owner_id, name: room.name, rev: effectiveRev(room),
    status: endTime(room) === null ? 'active' : 'ended', ended_at: endTime(room),
    players: state.players, members: state.members, invite_code: endTime(room) === null ? room.invite_code : '',
    invite_token: endTime(room) === null ? room.invite_token : '' }
}
export function text(value: unknown, fallback = '') {
  const name = typeof value === 'string' ? value.trim() : fallback
  if (!name || [...name].length > 24) throw badRequest('名称须为 1–24 字')
  return name
}
async function invite(db: Db) {
  const now = Date.now()
  const activeSince = now - IDLE_MS
  // 先把懒过期房间标成 ended，才能让仅 active 的部分唯一索引释放旧邀请码。
  await db.run('UPDATE score_rooms SET ended_at=last_activity_at+?,rev=rev+1 WHERE ended_at IS NULL AND last_activity_at<=?', [IDLE_MS, activeSince])
  for (let attempt = 0; attempt < 32; attempt++) {
    const code = String(randomInt(0, 10_000)).padStart(4, '0')
    const existing = await db.first('SELECT id FROM score_rooms WHERE invite_code=? AND ended_at IS NULL AND last_activity_at>?', [code, activeSince])
    if (!existing) return { code, token: randomBytes(24).toString('hex') }
  }
  throw conflict('暂时无法生成可用邀请码，请稍后重试')
}
function identityName(raw: string, state: State) {
  const base = [...raw.trim()].slice(0, 24).join('') || '成员'
  for (let suffix = 1; suffix <= ROOM_LIMIT; suffix++) {
    const tail = suffix === 1 ? '' : ` (${suffix})`
    const candidate = [...base].slice(0, 24 - [...tail].length).join('') + tail
    if (!state.players.some((player) => player.name === candidate)) return candidate
  }
  throw conflict('无法为你创建唯一玩家身份')
}
export async function loadRoom(db: Db, id: number, userId: number, active = false) {
  const room = await db.first<Room>('SELECT * FROM score_rooms WHERE id = ?', [id])
  if (!room || !visible(room)) throw notFound('记分房间已过期或不存在')
  if (!roomState(room).members.includes(userId)) throw forbidden('你不是该记分房间成员')
  if (active && endTime(room) !== null) throw conflict('记分已结束')
  return room
}

/** 查询 JSON 成员仅扫描尚未结束的临时房间；写语句内再验证，防并发双重加入。 */
const NO_ACTIVE = `NOT EXISTS (SELECT 1 FROM score_rooms r, json_each(r.state_json, '$.members') m
  WHERE r.ended_at IS NULL AND r.last_activity_at > ? AND m.value = ?)`
async function accountName(db: Db, userId: number) {
  const account = await db.first<{ nickname: string; username: string }>('SELECT nickname,username FROM users WHERE id=?', [userId])
  return account?.nickname?.trim() || account?.username || '成员'
}
export async function createRoom(db: Db, userId: number, body: Record<string, unknown>) {
  const names = body.players ?? []
  if (!Array.isArray(names) || names.length > ROOM_LIMIT) throw badRequest('玩家最多 10 位（含你自己）')
  const players: Player[] = names.map((name) => ({ id: randomBytes(8).toString('hex'), name: text(name), score: 0 }))
  if (new Set(players.map((p) => p.name)).size !== players.length) throw badRequest('玩家名称不能重复')
  // 房主自动绑定本人身份：名单里已有同名玩家就直接绑定，否则追加一位。
  const ownerName = await accountName(db, userId)
  const self = players.find((p) => p.name === ownerName)
  if (self) self.user_id = userId
  else players.push({ id: randomBytes(8).toString('hex'), name: identityName(ownerName, { members: [], players }), score: 0, user_id: userId })
  if (players.length > ROOM_LIMIT) throw badRequest('玩家最多 10 位（含你自己）')
  const state: State = { members: [userId], players }
  const now = Date.now()
  for (let attempt = 0; attempt < 32; attempt++) {
    const keys = await invite(db)
    try {
      const result = await db.batch([{ sql: `INSERT INTO score_rooms
        (owner_id,name,state_json,rev,invite_code,invite_token,created_at,last_activity_at)
        SELECT ?,?,?,1,?,?,?,? WHERE ${NO_ACTIVE}`, params: [userId, text(body.name, '临时记分'), JSON.stringify(state), keys.code, keys.token, now, now, now - IDLE_MS, userId], expectChanges: 1 }])
      return roomView(await loadRoom(db, result[0].lastId!, userId))
    } catch (e) {
      if (e instanceof BatchConflict) throw conflict('你已有进行中的房间，请进入当前房间')
      if (String(e).includes('UNIQUE constraint failed: score_rooms.invite_code')) continue
      throw e
    }
  }
  throw conflict('暂时无法生成可用邀请码，请稍后重试')
}

export async function mutateRoom(db: Db, id: number, userId: number,
  mutate: (room: Room, state: State) => { extra?: Stmt[]; end?: boolean; invite?: boolean; joining?: boolean; noop?: boolean }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const room = await db.first<Room>('SELECT * FROM score_rooms WHERE id = ?', [id])
    if (!room || !visible(room)) throw notFound('记分房间已过期或不存在')
    if (endTime(room) !== null) throw conflict('记分已结束')
    const state = roomState(room)
    const change = mutate(room, state)
    if (change.noop) return room
    const now = Date.now(), keys = change.invite ? await invite(db) : null
    try {
      await db.batch([{
        sql: `UPDATE score_rooms SET state_json=?, name=?, rev=rev+1, last_activity_at=?, ended_at=?, invite_code=?, invite_token=?
          WHERE id=? AND rev=? AND ended_at IS NULL AND last_activity_at > ? ${change.joining ? `AND ${NO_ACTIVE}` : ''}`,
        params: [JSON.stringify(state), room.name, now, change.end ? now : null, keys?.code ?? room.invite_code, keys?.token ?? room.invite_token,
          id, room.rev, now - IDLE_MS, ...(change.joining ? [now - IDLE_MS, userId] : [])], expectChanges: 1,
      }, ...(change.extra ?? [])])
      // 当前返回即本次提交快照，不将后续新版本与旧 JSON 拼接。
      return { ...room, state_json: JSON.stringify(state), rev: room.rev + 1, last_activity_at: now,
        ended_at: change.end ? now : null, invite_code: keys?.code ?? room.invite_code, invite_token: keys?.token ?? room.invite_token }
    } catch (e) {
      if (change.invite && String(e).includes('UNIQUE constraint failed: score_rooms.invite_code')) continue
      if (!(e instanceof BatchConflict)) throw e
      if (change.joining) {
        const occupied = await db.first(`SELECT r.id FROM score_rooms r,json_each(r.state_json,'$.members') m
          WHERE r.ended_at IS NULL AND r.last_activity_at>? AND m.value=? AND r.id<>?`, [Date.now() - IDLE_MS, userId, id])
        if (occupied) throw conflict('你已有进行中的房间，请先退出或结束')
      }
    }
  }
  throw conflict('其他人正在更新，请重试')
}
export async function joinRoom(db: Db, userId: number, body: Record<string, unknown>) {
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : ''
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if ((!code && !token) || code.length > 32 || token.length > 96) throw badRequest('邀请码无效')
  const found = await db.first<Room>(`SELECT * FROM score_rooms WHERE ${token ? 'invite_token' : 'invite_code'}=?`, [token || code])
  if (!found || endTime(found) !== null) throw notFound('邀请已失效或记分已结束')
  const preferredName = await accountName(db, userId)
  return roomView(await mutateRoom(db, found.id, userId, (room, state) => {
    if ((token ? room.invite_token !== token : room.invite_code !== code)) throw notFound('邀请已失效')
    const existingIdentity = state.players.some((player) => player.user_id === userId)
    if (state.members.includes(userId) && existingIdentity) return { noop: true }
    if (!state.members.includes(userId) && state.members.length >= ROOM_LIMIT) throw conflict('房间成员已满 10 人')
    if (!existingIdentity) {
      if (state.players.length >= ROOM_LIMIT) throw conflict('玩家已满 10 人，请管理员先删除未认领玩家')
      state.players.push({ id: randomBytes(8).toString('hex'), name: identityName(preferredName, state), score: 0, user_id: userId })
    }
    if (!state.members.includes(userId)) state.members.push(userId)
    return { joining: true }
  }))
}
export function requireMember(room: Room, state: State, userId: number, owner = false) {
  if (!state.members.includes(userId)) throw forbidden('你不是该记分房间成员')
  if (owner && room.owner_id !== userId) throw forbidden('仅房主可操作')
}
export async function transferScore(db: Db, id: number, userId: number, body: Record<string, unknown>) {
  const targetId = typeof body.to_player_id === 'string' ? body.to_player_id : ''
  const requestedSourceId = typeof body.from_player_id === 'string' ? body.from_player_id : ''
  const delta = body.delta
  const requestId = typeof body.request_id === 'string' ? body.request_id : ''
  if (!Number.isSafeInteger(delta) || (delta as number) <= 0 || (delta as number) > 1_000_000) throw badRequest('转分须为 1–1000000 的整数')
  if (!/^[\w-]{8,80}$/.test(requestId)) throw badRequest('操作号无效')
  const initial = await loadRoom(db, id, userId)
  const initialState = roomState(initial)
  const sourceId = initial.owner_id === userId
    ? requestedSourceId
    : initialState.players.find((player) => player.user_id === userId && !player.disabled)?.id || ''
  if (!sourceId || !targetId) throw badRequest(initial.owner_id === userId ? '请选择转出和接收玩家' : '未找到你的玩家身份，请重新通过邀请加入')
  if (sourceId === targetId) throw badRequest('不能给自己转分')
  async function duplicate() {
    const old = await db.first<Entry>('SELECT * FROM score_entries WHERE room_id=? AND created_by=? AND request_id=?', [id, userId, requestId])
    if (!old) return null
    if (old.from_player_id !== sourceId || old.player_id !== targetId || old.delta !== delta) throw conflict('操作号已用于其他转分')
    return old
  }
  const old = await duplicate()
  if (old) return { entry: old, room: roomView(await loadRoom(db, id, userId)) }
  try {
    const room = await mutateRoom(db, id, userId, (room, state) => {
      requireMember(room, state, userId)
      const source = state.players.find((player) => player.id === sourceId && !player.disabled)
      const target = state.players.find((player) => player.id === targetId && !player.disabled)
      if (!source || !target) throw badRequest('转出或接收玩家不存在或已停用')
      if (room.owner_id !== userId && source.user_id !== userId) throw forbidden('只能从自己的身份转分')
      const sourceScore = source.score - (delta as number)
      const targetScore = target.score + (delta as number)
      if (Math.abs(sourceScore) > SCORE_LIMIT || Math.abs(targetScore) > SCORE_LIMIT) throw badRequest('累计分数超出范围')
      source.score = sourceScore
      target.score = targetScore
      const entry = { room_id: id, player_id: target.id, player_name: target.name, delta: delta as number,
        score_after: targetScore, from_player_id: source.id, from_player_name: source.name, from_score_after: sourceScore,
        created_by: userId, request_id: requestId, created_at: Date.now() }
      return { extra: [{ sql: `INSERT INTO score_entries(room_id,player_id,player_name,delta,score_after,from_player_id,from_player_name,from_score_after,created_by,request_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [entry.room_id, entry.player_id, entry.player_name, entry.delta, entry.score_after,
          entry.from_player_id, entry.from_player_name, entry.from_score_after, entry.created_by, entry.request_id, entry.created_at] }] }
    })
    const saved = await duplicate()
    return { entry: saved, room: roomView(room) }
  } catch (e) {
    if (String(e).includes('UNIQUE constraint failed: score_entries')) {
      const saved = await duplicate()
      if (saved) return { entry: saved, room: roomView(await loadRoom(db, id, userId)) }
    }
    throw e
  }
}

export async function cleanupScore(db: Db, now = Date.now()) {
  await db.batch([
    { sql: 'UPDATE score_rooms SET ended_at=last_activity_at+?,rev=rev+1 WHERE ended_at IS NULL AND last_activity_at<=?', params: [IDLE_MS, now - IDLE_MS] },
    { sql: 'DELETE FROM score_entries WHERE room_id IN (SELECT id FROM score_rooms WHERE ended_at<=?)', params: [now - KEEP_MS] },
    { sql: 'DELETE FROM score_rooms WHERE ended_at<=?', params: [now - KEEP_MS] },
  ])
}

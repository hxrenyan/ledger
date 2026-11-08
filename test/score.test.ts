import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { cleanupScore, IDLE_MS, KEEP_MS } from '../src/score/service.ts'
import { BatchConflict } from '../src/db/types.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({ db, jwtSecret: 'score-test-secret', adminToken: 'admin-test' })
  async function api(path: string, token = '', body?: unknown, method?: string) {
    const res = await app.request('/api/v1/' + path, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  async function user(n: number) { return (await api('auth/register', '', { username: 'scoreuser' + n, password: 'password1', nickname: '成员' + n })).body }
  return { db, api, user }
}

describe('临时记分', () => {
  it('已有库迁移只创建两张记分表及必要索引，重复执行不改数据', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-score-'))
    try {
      const path = join(directory, 'ledger.db'), db = createSqliteDb(path)
      const schema = readFileSync('sql/schema.sql', 'utf8')
        .replace(/CREATE TABLE IF NOT EXISTS score_(rooms|entries)\s*\([\s\S]*?\);/g, '')
        .replace(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_score_[^;]+;/g, '')
      await db.exec(schema)
      expect(await db.all("SELECT name FROM sqlite_master WHERE name LIKE 'score_%'")).toHaveLength(0)
      const run = () => spawnSync(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' })
      const first = run()
      expect(first.status, first.stderr).toBe(0)
      await db.run(`INSERT INTO score_rooms(owner_id,name,state_json,invite_code,invite_token,created_at,last_activity_at) VALUES(1,'验证','{"members":[1],"players":[]}', 'migration-code','migration-token',0,0)`)
      const second = run()
      expect(second.status, second.stderr).toBe(0)
      expect((await db.all('SELECT * FROM score_rooms')).length).toBe(1)
      expect(await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'score_%'")).toHaveLength(2)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('已有记分历史通过增量迁移补齐转出快照列', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-score-transfer-'))
    try {
      const path = join(directory, 'ledger.db'), db = createSqliteDb(path)
      const schema = readFileSync('sql/schema.sql', 'utf8')
        .replace(/^  from_player_id TEXT,\n/gm, '')
        .replace(/^  from_player_name TEXT,\n/gm, '')
        .replace(/^  from_score_after INTEGER,\n/gm, '')
      await db.exec(schema)
      await db.run(`INSERT INTO score_rooms(owner_id,name,state_json,invite_code,invite_token,created_at,last_activity_at)
        VALUES(1,'验证','{"members":[1],"players":[]}', 'transfer-code','transfer-token',0,0)`)
      await db.run(`INSERT INTO score_entries(room_id,player_id,player_name,delta,score_after,created_by,request_id,created_at)
        VALUES(1,'p1','张三',5,5,1,'legacy-entry',1)`)
      const migration = spawnSync(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' })
      expect(migration.status, migration.stderr).toBe(0)
      const columns = (await db.all<{ name: string }>('PRAGMA table_info(score_entries)')).map((column) => column.name)
      expect(columns).toContain('from_player_id')
      expect(columns).toContain('from_player_name')
      expect(columns).toContain('from_score_after')
      expect(await db.first('SELECT * FROM score_entries WHERE request_id=?', ['legacy-entry'])).toMatchObject({ delta: 5, from_player_id: null })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('启动时为已有记分表补转出快照列并保留原记录', async () => {
    const db = createSqliteDb(':memory:')
    const schema = readFileSync('sql/schema.sql', 'utf8')
      .replace(/^  from_player_id TEXT,\n/gm, '')
      .replace(/^  from_player_name TEXT,\n/gm, '')
      .replace(/^  from_score_after INTEGER,\n/gm, '')
    await db.exec(schema)
    await db.run(`INSERT INTO score_rooms(owner_id,name,state_json,invite_code,invite_token,created_at,last_activity_at)
      VALUES(1,'验证','{"members":[1],"players":[]}', 'startup-code','startup-token',0,0)`)
    await db.run(`INSERT INTO score_entries(room_id,player_id,player_name,delta,score_after,created_by,request_id,created_at)
      VALUES(1,'p1','张三',-3,-3,1,'startup-entry',1)`)
    await ensureMigrated(db)
    expect(await db.first('SELECT * FROM score_entries WHERE request_id=?', ['startup-entry']))
      .toMatchObject({ delta: -3, score_after: -3, from_player_id: null, from_player_name: null })
  })

  it('两张表无外键，条件写入失败回滚整个 batch', async () => {
    const { db } = await setup()
    expect(await db.all('PRAGMA foreign_key_list(score_entries)')).toEqual([])
    await expect(db.batch([{ sql: "INSERT INTO app_configs(key,value,updated_at) VALUES('rollback','{}',0)" },
      { sql: 'UPDATE users SET nickname=? WHERE id=?', params: ['无', 999999], expectChanges: 1 }])).rejects.toBeInstanceOf(BatchConflict)
    expect(await db.first("SELECT * FROM app_configs WHERE key='rollback'")).toBeNull()
    const plans = await db.all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT * FROM score_entries WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 20', [1, 100])
    expect(plans.some((p) => p.detail.includes('idx_score_entries_room_id'))).toBe(true)
  })

  it('所有成员记分、认领、历史、幂等、非成员拒绝、独立于账本', async () => {
    const { api, user } = await setup(), owner = await user(1), guest = await user(2), stranger = await user(3)
    const room = await api('score/rooms', owner.token, { players: ['张三', '李四'] })
    expect(room.status).toBe(201)
    expect(room.body.invite_code).toMatch(/^\d{4}$/)
    const r = room.body, path = 'score/rooms/' + r.id
    expect(r.players.map((player: any) => player.name)).toEqual(['张三', '李四', '成员1'])
    expect(r.players[2].user_id).toBe(owner.user.id)
    expect((await api(path, stranger.token)).status).toBe(403)
    const joined = await api('score/join', guest.token, { token: r.invite_token })
    expect(joined.status).toBe(200)
    const identity = joined.body.players.find((player: any) => player.user_id === guest.user.id)
    expect(identity).toMatchObject({ name: '成员2', score: 0 })
    const payload = { from_player_id: r.players[1].id, to_player_id: r.players[0].id, delta: 10, request_id: 'operation-0001' }
    const added = await api(path + '/entries', guest.token, payload)
    expect(added.status).toBe(200)
    expect(added.body.room.players.find((player: any) => player.id === identity.id).score).toBe(-10)
    expect(added.body.room.players[0].score).toBe(10)
    expect(added.body.entry).toMatchObject({ from_player_id: identity.id, from_player_name: '成员2', from_score_after: -10, score_after: 10 })
    expect((await api(path + '/entries', guest.token, payload)).body.room.players[0].score).toBe(10)
    expect((await api(path + '/entries', guest.token, { ...payload, delta: 20 })).status).toBe(409)
    expect((await api(path + '/entries', guest.token, { ...payload, request_id: 'operation-0002', delta: -1 })).status).toBe(400)
    const history = (await api(path + '/entries', owner.token)).body
    expect(history.items).toHaveLength(1)
    expect(history.items[0]).toMatchObject({ created_by_name: '成员2', from_player_name: '成员2', player_name: '张三', delta: 10, score_after: 10 })
    expect((await api(path + '/players', guest.token, { name: '王五' })).status).toBe(403)
    expect((await api(path + '/end', guest.token, {})).status).toBe(403)
    expect((await api(path + '/players/' + r.players[0].id, owner.token, {}, 'DELETE')).status).toBe(409)
    expect((await api(path + '/players/' + r.players[1].id, owner.token, {}, 'DELETE')).status).toBe(200)
    expect((await api(path, owner.token)).body.players.some((player: any) => player.id === r.players[1].id)).toBe(false)
    expect((await api(path + '/players/' + identity.id, owner.token, {}, 'DELETE')).status).toBe(409)
    expect((await api(path + '/leave', guest.token, {})).status).toBe(200)
    expect((await api(path, guest.token)).status).toBe(403)
    expect((await api(path + '/leave', owner.token, {})).status).toBe(409)
  })

  it('并发创建或加入只占一个房间，10人和10玩家硬上限', async () => {
    const { api, user } = await setup(), owner = await user(1)
    const results = await Promise.all([api('score/rooms', owner.token, { players: [] }), api('score/rooms', owner.token, { players: [] })])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    const room = results.find((r) => r.status === 201)!.body
    const other = await user(2)
    const second = (await api('score/rooms', other.token, { players: ['C'] })).body
    const guest = await user(3)
    const joined = await Promise.all([api('score/join', guest.token, { code: room.invite_code }), api('score/join', guest.token, { code: second.invite_code })])
    expect(joined.map((r) => r.status).sort()).toEqual([200, 409])
    const current = (await api('score/rooms/' + room.id, owner.token)).body
    const joinCount = 10 - current.members.length
    for (let i = 4; i < 4 + joinCount; i++) {
      const member = await user(i)
      const result = await api('score/join', member.token, { code: room.invite_code })
      expect(result.status).toBe(200)
      expect(result.body.players.some((player: any) => player.user_id === member.user.id)).toBe(true)
    }
    expect((await api('score/join', (await user(20)).token, { code: room.invite_code })).status).toBe(409)
    expect((await api('score/rooms/' + room.id + '/players', owner.token, { name: '满员' })).status).toBe(409)
  })

  it('房主自动绑定本人身份，名单含同名时直接绑定，不超过10位', async () => {
    const { api, user } = await setup(), owner = await user(1), other = await user(2)
    const room = (await api('score/rooms', owner.token, { players: ['成员1', '张三'] })).body
    expect(room.players).toHaveLength(2)
    expect(room.players[0]).toMatchObject({ name: '成员1', user_id: owner.user.id })
    const self = await api('score/rooms/' + room.id + '/entries', owner.token, { from_player_id: room.players[0].id, to_player_id: room.players[1].id, delta: 3, request_id: 'owner-self-1' })
    expect(self.body.room.players.map((player: any) => player.score)).toEqual([-3, 3])
    const full = await api('score/rooms', other.token, { players: Array.from({ length: 10 }, (_, i) => '玩家' + i) })
    expect(full.status).toBe(400)
    expect((await api('score/rooms', other.token, {})).body.players).toEqual([expect.objectContaining({ name: '成员2', user_id: other.user.id })])
  })

  it('并发分数不丢失，分页稳定，重置邀请使旧邀请失效', async () => {
    const { api, user, db } = await setup(), owner = await user(1), guest = await user(2)
    const r = (await api('score/rooms', owner.token, { players: ['A', 'B'] })).body, path = 'score/rooms/' + r.id
    const joined = await api('score/join', guest.token, { code: r.invite_code })
    const guestPlayer = joined.body.players.find((player: any) => player.user_id === guest.user.id)
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => api(path + '/entries', i % 2 ? owner.token : guest.token,
      i % 2 ? { from_player_id: r.players[1].id, to_player_id: r.players[0].id, delta: 2, request_id: 'concurrent-' + i }
        : { to_player_id: r.players[0].id, delta: 2, request_id: 'concurrent-' + i })))
    expect(results.every((r) => r.status === 200)).toBe(true)
    const scored = (await api(path, owner.token)).body.players
    expect(scored.find((player: any) => player.id === r.players[0].id).score).toBe(8)
    expect(scored.find((player: any) => player.id === r.players[1].id).score).toBe(-4)
    expect(scored.find((player: any) => player.id === guestPlayer.id).score).toBe(-4)
    expect(scored.reduce((sum: number, player: any) => sum + player.score, 0)).toBe(0)
    const first = (await api(path + '/entries?limit=2', owner.token)).body
    const second = (await api(path + '/entries?limit=2&before=' + first.next, owner.token)).body
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(4)
    const reset = (await api(path + '/invite/reset', owner.token, {})).body
    const third = await user(3)
    expect((await api('score/join', third.token, { code: r.invite_code })).status).toBe(404)
    expect((await api('score/join', third.token, { token: reset.invite_token })).status).toBe(200)
    expect((await db.all('SELECT * FROM score_entries')).length).toBe(4)
  })

  it('过期只读、心跳不续期、清理无孤儿、历史房间不占名额', async () => {
    const { api, user, db } = await setup(), owner = await user(1)
    const room = (await api('score/rooms', owner.token, { players: ['A', 'B'] })).body, path = 'score/rooms/' + room.id
    await api(path + '/entries', owner.token, { from_player_id: room.players[1].id, to_player_id: room.players[0].id, delta: 5, request_id: 'expire-entry' })
    const last = Date.now() - IDLE_MS - 1000
    await db.run('UPDATE score_rooms SET last_activity_at=? WHERE id=?', [last, room.id])
    const ended = (await api(path, owner.token)).body
    expect(ended.status).toBe('ended')
    expect(ended.ended_at).toBe(last + IDLE_MS)
    expect((await api(path + '/entries', owner.token, { from_player_id: room.players[1].id, to_player_id: room.players[0].id, delta: 1, request_id: 'expired-new' })).status).toBe(409)
    expect((await api('app/heartbeat', owner.token, { s: { ['game:' + room.id]: 1 } })).body.s['game:' + room.id]).toBe(ended.rev)
    await cleanupScore(db)
    expect((await api(path, owner.token)).body.rev).toBe(ended.rev)
    expect((await api('score/rooms', owner.token, { players: ['新房间'] })).status).toBe(201)
    await cleanupScore(db, Date.now() + KEEP_MS + 2000)
    expect((await api(path, owner.token)).status).toBe(404)
    expect(await db.first('SELECT * FROM score_entries WHERE room_id=?', [room.id])).toBeNull()
  })
})

describe('心跳与公告', () => {
  it('游客公共订阅、空响应、私有授权、瘦响应和格式校验', async () => {
    const { api, user } = await setup()
    expect((await api('app/heartbeat', '', {})).body).toEqual({})
    expect((await api('app/heartbeat', '', { s: { ann: 0, 'game:123': 0 } })).body).toEqual({ x: ['game:123'] })
    expect((await api('app/heartbeat', 'invalid', {})).status).toBe(401)
    for (const s of [{ arbitrary: 0 }, { ann: -1 }, { 'game:1': 0, 'game:2': 0 }]) expect((await api('app/heartbeat', '', { s })).status).toBe(400)
    const owner = await user(1), stranger = await user(2)
    const room = (await api('score/rooms', owner.token, { players: ['A'] })).body
    const key = 'game:' + room.id
    expect((await api('app/heartbeat', owner.token, { s: { [key]: room.rev } })).body).toEqual({})
    expect((await api('app/heartbeat', stranger.token, { s: { [key]: 0 } })).body).toEqual({ x: [key] })
    const admin = (await api('admin/login', '', { password: 'admin-test' })).body
    expect((await api('admin/announcements', admin.token, null, 'PUT')).status).toBe(400)
    expect((await api('admin/announcements', admin.token, { items: [{ id: 'bad', title: '', body: '' }] }, 'PUT')).status).toBe(400)
    expect((await api('admin/announcements', admin.token, { items: [{ id: 'welcome', title: '欢迎', body: '公告内容' }] }, 'PUT')).status).toBe(200)
    expect((await api('app/heartbeat', '', { s: { ann: 0 } })).body).toEqual({ s: { ann: 1 } })
    expect((await api('app/announcements')).body.items[0].title).toBe('欢迎')
    await api('admin/announcements', admin.token, { items: [] }, 'PUT')
    expect((await api('app/announcements')).body).toEqual({ rev: 2, items: [] })
  })
})

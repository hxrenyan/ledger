import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { versionBelow } from '../src/miniprogram/clientConfig.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({ db, jwtSecret: 'test-secret-test-secret', adminToken: 'admin-secret' })
  return { app }
}

async function json(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  const res = await app.request(path, init)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function adminToken(app: ReturnType<typeof createApp>) {
  const login = await json(app, '/api/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-secret' }),
  })
  return (login.body as { token: string }).token
}

describe('版本比较', () => {
  it('按点分段比较，空版本低于任何最低版本', () => {
    expect(versionBelow('1.2.0', '1.2.0')).toBe(false)
    expect(versionBelow('1.2', '1.2.0')).toBe(false)
    expect(versionBelow('1.1.9', '1.2.0')).toBe(true)
    expect(versionBelow('1.3', '1.2.0')).toBe(false)
    expect(versionBelow('', '1.0.0')).toBe(true)
    expect(versionBelow('1.0.0', '')).toBe(false)
  })
})

describe('小程序关于与强制更新', () => {
  it('没配过就用默认文案，不要求更新', async () => {
    const { app } = await setup()
    const res = await json(app, '/api/v1/app/client?version=1.0.0')
    expect(res.status).toBe(200)
    const body = res.body as { about_title: string; about_body: string; update_required: boolean; min_version: string }
    expect(body.about_title).toBe('记账')
    expect(body.about_body).toContain('个人和家庭记账')
    expect(body.min_version).toBe('')
    expect(body.update_required).toBe(false)
  })

  it('后台改文案和最低版本后，低版本必须更新', async () => {
    const { app } = await setup()
    const token = await adminToken(app)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const saved = await json(app, '/api/v1/admin/miniprogram', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        about_title: '记账本',
        about_body: '一家人一起记。',
        min_version: '1.2.0',
        update_message: '请更新后再用',
      }),
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({
      about_title: '记账本',
      about_body: '一家人一起记。',
      min_version: '1.2.0',
      update_message: '请更新后再用',
    })

    const low = await json(app, '/api/v1/app/client?version=1.1.0')
    expect(low.body).toMatchObject({ update_required: true, update_message: '请更新后再用' })
    const ok = await json(app, '/api/v1/app/client?version=1.2.0')
    expect((ok.body as { update_required: boolean }).update_required).toBe(false)

    const bad = await json(app, '/api/v1/admin/miniprogram', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        about_title: '记账',
        about_body: '说明',
        min_version: 'v1',
        update_message: '',
      }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('管理后台账本成员', () => {
  it('列出账本里的用户，并按成员账号搜到', async () => {
    const { app } = await setup()
    const owner = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner1', password: 'password1', nickname: '主人' }),
    })
    const ownerBody = owner.body as { token: string; ledgers: { id: number }[] }
    const headers = {
      authorization: `Bearer ${ownerBody.token}`,
      'x-ledger-id': String(ownerBody.ledgers[0].id),
    }
    const members = await json(app, '/api/v1/members', { headers })
    const code = (members.body as { invite_code: string }).invite_code
    const guest = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'guest1', password: 'password1', nickname: '家人' }),
    })
    const guestBody = guest.body as { token: string }
    const joined = await json(app, '/api/v1/ledgers/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${guestBody.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    expect(joined.status).toBe(201)

    const token = await adminToken(app)
    const listed = await json(app, '/api/v1/admin/ledgers?q=' + encodeURIComponent('owner1'), {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(listed.status).toBe(200)
    const items = (listed.body as { items: { name: string; members: { username: string; nickname: string; role: string }[] }[] }).items
    expect(items).toHaveLength(1)
    expect(items[0].members.map((item) => item.username)).toEqual(['owner1', 'guest1'])
    expect(items[0].members[0]).toMatchObject({ nickname: '主人', role: 'owner' })
    expect(items[0].members[1]).toMatchObject({ nickname: '家人', role: 'member' })
  })
})

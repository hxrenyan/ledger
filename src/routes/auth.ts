import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { hashPassword, assertNickname, assertPassword, assertUsername, verifyPassword } from '../auth/password.ts'
import { signToken } from '../auth/jwt.ts'
import { badRequest, conflict, unauthorized } from '../http.ts'
import { bootstrapLedgerStmts, newId } from '../seed.ts'

type UserRow = {
  id: string
  username: string
  nickname: string
  password_hash: string | null
  disabled?: number
}

async function sessionPayload(db: AppEnv['Variables']['db'], user: { id: string; username: string; nickname: string }, token: string) {
  const ledgers = await db.all<{ id: string; name: string; role: string }>(
    `SELECT l.id, l.name, m.role
     FROM members m JOIN ledgers l ON l.id = m.ledger_id
     WHERE m.user_id = ?
     ORDER BY l.created_at ASC`,
    [user.id],
  )
  return {
    token,
    user: { id: user.id, username: user.username, nickname: user.nickname },
    ledgers,
  }
}

export function registerAuthRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/auth/register', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const username = assertUsername(body.username)
    const password = assertPassword(body.password)
    const nickname = assertNickname(body.nickname, username)
    const db = c.get('db')

    const exists = await db.first(`SELECT id FROM users WHERE username = ?`, [username])
    if (exists) throw conflict('用户名已被占用')

    const userId = newId()
    const now = Date.now()
    const passwordHash = await hashPassword(password)
    const { stmts } = bootstrapLedgerStmts({
      userId,
      username,
      nickname,
      passwordHash,
      now,
    })
    try {
      await db.batch(stmts)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('UNIQUE')) throw conflict('用户名已被占用')
      throw e
    }

    const token = await signToken(c.get('jwtSecret'), userId)
    return c.json(
      await sessionPayload(db, { id: userId, username, nickname }, token),
      201,
    )
  })

  app.post('/api/v1/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password) throw badRequest('请输入用户名和密码')

    const db = c.get('db')
    const user = await db.first<UserRow>(
      `SELECT id, username, nickname, password_hash, disabled FROM users WHERE username = ?`,
      [username],
    )
    if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
      throw unauthorized('用户名或密码错误')
    }
    if (user.disabled) throw unauthorized('账号已停用')
    const token = await signToken(c.get('jwtSecret'), user.id)
    return c.json(await sessionPayload(db, user, token))
  })

  app.post('/api/v1/auth/wechat', (c) =>
    c.json({ code: 'not_implemented', message: '微信登录将在迁移 Sealos 后开放' }, 501),
  )

  app.get('/api/v1/me', async (c) => {
    const db = c.get('db')
    const user = await db.first<UserRow>(
      `SELECT id, username, nickname, password_hash FROM users WHERE id = ?`,
      [c.get('userId')],
    )
    if (!user) throw unauthorized()
    const token = (c.req.header('Authorization') ?? '').slice(7)
    return c.json(await sessionPayload(db, user, token))
  })
}

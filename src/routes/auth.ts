import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { hashPassword, assertNickname, assertPassword, assertUsername, verifyPassword } from '../auth/password.ts'
import { signToken } from '../auth/jwt.ts'
import { bindWechatToExistingAccount, loginWithWechat } from '../auth/wechat.ts'
import { HttpError, badRequest, conflict, unauthorized } from '../http.ts'
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
  const flags = await db.first<{ has_password: unknown; wechat_bound: unknown }>(
    `SELECT password_hash IS NOT NULL AS has_password,
            EXISTS(SELECT 1 FROM user_identities i WHERE i.provider = 'wechat' AND i.user_id = users.id) AS wechat_bound
     FROM users WHERE id = ?`,
    [user.id],
  )
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      has_password: flag(flags?.has_password),
      wechat_bound: flag(flags?.wechat_bound),
    },
    ledgers,
  }
}

function flag(v: unknown): boolean {
  return v === true || v === 1
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

  app.post('/api/v1/auth/wechat', async (c) => {
    const exchange = c.get('exchangeWechatCode')
    if (!exchange) throw new HttpError(503, 'wechat_unconfigured', '未配置微信小程序登录')
    const body = await c.req.json().catch(() => ({}))
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code || code.length > 128) throw badRequest('缺少微信登录码')
    const { user, created } = await loginWithWechat(c.get('db'), await exchange(code))
    const token = await signToken(c.get('jwtSecret'), user.id)
    return c.json(await sessionPayload(c.get('db'), user, token), created ? 201 : 200)
  })

  app.post('/api/v1/me/wechat/bind', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password) throw badRequest('请输入用户名和密码')
    const user = await bindWechatToExistingAccount(c.get('db'), c.get('userId'), username, password)
    const token = await signToken(c.get('jwtSecret'), user.id)
    return c.json(await sessionPayload(c.get('db'), user, token))
  })

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

import type { Db } from '../db/types.ts'
import { HttpError, badRequest, conflict, unauthorized } from '../http.ts'
import { mergeUserStmts } from './mergeUser.ts'
import { verifyPassword } from './password.ts'
import { bootstrapLedgerStmts } from '../seed.ts'

const WECHAT = 'wechat'
const NICKNAME = '微信用户'

export type WechatIdentity = { openid: string; unionid: string | null }

export type WechatCodeExchange = (code: string) => Promise<WechatIdentity>

export type SessionUser = { id: number; username: string; nickname: string }

type WechatConfig = {
  wechatAppId?: string
  wechatAppSecret?: string
  exchangeWechatCode?: WechatCodeExchange
}

/**
 * 测试可以注入 exchangeWechatCode。否则用小程序 AppId / AppSecret 调 jscode2session。
 * 两者都没有时返回 null，路由回答 503，而不是假装登录成功。
 */
export function resolveWechatExchange(cfg: WechatConfig): WechatCodeExchange | null {
  if (cfg.exchangeWechatCode) return cfg.exchangeWechatCode
  const appId = cfg.wechatAppId?.trim() ?? ''
  const appSecret = cfg.wechatAppSecret?.trim() ?? ''
  if (!appId || !appSecret) return null
  return (code) => exchangeWechatCode(appId, appSecret, code)
}

type WechatApiBody = {
  openid?: unknown
  unionid?: unknown
  errcode?: unknown
  errmsg?: unknown
}

/** 用 wx.login 的 code 换 openid。session_key 不返回、不落库。 */
export async function exchangeWechatCode(
  appId: string,
  appSecret: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WechatIdentity> {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET' })
  } catch {
    // 不打印异常对象：失败信息里可能带上含 AppSecret 的请求地址。
    console.error('微信登录请求失败')
    throw new HttpError(502, 'wechat_failed', '微信登录失败')
  }

  const data = (await res.json().catch(() => null)) as WechatApiBody | null
  if (!data || typeof data !== 'object') throw new HttpError(502, 'wechat_failed', '微信登录失败')

  const errcode = typeof data.errcode === 'number' ? data.errcode : 0
  if (errcode !== 0) throw wechatApiError(errcode)

  const openid = wechatId(data.openid)
  if (!openid) throw new HttpError(502, 'wechat_failed', '微信登录失败')
  return { openid, unionid: wechatId(data.unionid) }
}

export async function loginWithWechat(db: Db, identity: WechatIdentity): Promise<{ user: SessionUser; created: boolean }> {
  const found = await findWechatUser(db, identity.openid)
  if (found) {
    await fillUnionid(db, identity)
    return { user: found, created: false }
  }
  try {
    return { user: await createWechatUser(db, identity), created: true }
  } catch (e) {
    if (!isUnique(e)) throw e
    const again = await findWechatUser(db, identity.openid)
    if (again) return { user: again, created: false }
    throw e
  }
}

/**
 * 微信账号和密码账号先各自能用。绑定后合成 target 这一个账号：
 * 密码和用户名留在 target，微信身份挂过来，两边的个人账本数据并进去。
 */
export async function bindWechatToExistingAccount(
  db: Db,
  currentUserId: number,
  username: string,
  password: string,
): Promise<SessionUser> {
  const identity = await db.first<{ openid: string }>(
    `SELECT openid FROM user_identities WHERE provider = ? AND user_id = ?`,
    [WECHAT, currentUserId],
  )
  if (!identity) throw badRequest('当前账号还没有微信登录，无法绑定')

  const target = await db.first<{
    id: number
    username: string
    nickname: string
    password_hash: string | null
    disabled: number
  }>(
    `SELECT id, username, nickname, password_hash, disabled FROM users WHERE username = ?`,
    [username],
  )
  if (!target?.password_hash || !(await verifyPassword(password, target.password_hash))) {
    throw unauthorized('用户名或密码错误')
  }
  if (target.disabled) throw unauthorized('账号已停用')
  if (target.id === currentUserId) throw badRequest('不能绑定当前登录的账号')

  const taken = await db.first(
    `SELECT openid FROM user_identities WHERE provider = ? AND user_id = ?`,
    [WECHAT, target.id],
  )
  if (taken) throw conflict('该账号已绑定其他微信')

  const stmts = await mergeUserStmts(db, currentUserId, target.id, identity.openid)
  try {
    await db.batch(stmts)
  } catch (e) {
    if (isUnique(e)) throw conflict('该账号已绑定其他微信')
    throw e
  }
  const moved = await db.first<{ user_id: number }>(
    `SELECT user_id FROM user_identities WHERE provider = ? AND openid = ?`,
    [WECHAT, identity.openid],
  )
  if (moved?.user_id !== target.id) throw conflict('绑定失败，请重试')
  return { id: target.id, username: target.username, nickname: target.nickname }
}

function wechatApiError(errcode: number): HttpError {
  console.error('微信登录失败', errcode)
  if (errcode === 40029 || errcode === 40163) {
    return new HttpError(401, 'wechat_code', '微信登录已失效，请重试')
  }
  if (errcode === 40013 || errcode === 40125) {
    return new HttpError(503, 'wechat_unconfigured', '微信登录配置无效')
  }
  return new HttpError(502, 'wechat_failed', '微信登录失败')
}

function wechatId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(v)) return null
  return v
}

async function findWechatUser(db: Db, openid: string): Promise<SessionUser | null> {
  const row = await db.first<{ id: number; username: string; nickname: string; disabled: number }>(
    `SELECT u.id, u.username, u.nickname, u.disabled
     FROM user_identities i JOIN users u ON u.id = i.user_id
     WHERE i.provider = ? AND i.openid = ?`,
    [WECHAT, openid],
  )
  if (!row) return null
  if (row.disabled) throw unauthorized('账号已停用')
  return { id: row.id, username: row.username, nickname: row.nickname }
}

async function fillUnionid(db: Db, identity: WechatIdentity) {
  if (!identity.unionid) return
  await db.run(
    `UPDATE user_identities SET unionid = ? WHERE provider = ? AND openid = ? AND unionid IS NULL`,
    [identity.unionid, WECHAT, identity.openid],
  )
}

async function createWechatUser(db: Db, identity: WechatIdentity): Promise<SessionUser> {
  for (let i = 0; i < 3; i++) {
    const username = wechatUsername()
    const exists = await db.first(`SELECT id FROM users WHERE username = ?`, [username])
    if (exists) continue
    const now = Date.now()
    const { stmts } = bootstrapLedgerStmts({
      username,
      nickname: NICKNAME,
      passwordHash: null,
      now,
    })
    stmts.push({
      sql: `INSERT INTO user_identities (provider, openid, user_id, unionid, created_at)
            SELECT ?, ?, id, ?, ? FROM users WHERE username = ?`,
      params: [WECHAT, identity.openid, identity.unionid, now, username],
    })
    try {
      await db.batch(stmts)
      const created = await db.first<SessionUser>(
        `SELECT id, username, nickname FROM users WHERE username = ?`,
        [username],
      )
      if (!created) throw conflict('创建微信账号失败，请重试')
      return created
    } catch (e) {
      if (!isUnique(e)) throw e
      if (uniqueOnOpenid(e)) throw e
    }
  }
  throw conflict('创建微信账号失败，请重试')
}

function wechatUsername(): string {
  return `wx_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isUnique(e: unknown): boolean {
  return e instanceof Error && e.message.includes('UNIQUE')
}

function uniqueOnOpenid(e: unknown): boolean {
  return e instanceof Error && e.message.includes('user_identities')
}

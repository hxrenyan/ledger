import type { Db, Stmt } from '../db/types.ts'
import { badRequest, forbidden, HttpError } from '../http.ts'
import { addDays, shanghaiDate } from '../time.ts'

const WECHAT = 'wechat'
const SIGNUP_POINTS = 10
const DAILY_CALL_LIMIT = 30

export type PointKind =
  | 'signup_grant'
  | 'daily_enter'
  | 'streak_bonus'
  | 'speech'
  | 'image'
  | 'text'
  | 'refund'
  | 'admin_grant'
  | 'admin_deduct'

const KIND_LABEL: Record<string, string> = {
  signup_grant: '新用户赠送',
  daily_enter: '每日进入',
  streak_bonus: '连续进入奖励',
  speech: '语音识别',
  image: '图片识别',
  text: '文本整理',
  refund: '退回',
  admin_grant: '管理员分配',
  admin_deduct: '管理员扣减',
}

export type PointView = {
  id: number
  delta: number
  balance_after: number
  kind: string
  title: string
  note: string
  created_at: number
  time: string
}

export type PointsSummary = {
  wechat: boolean
  balance: number
  streak: number
  today_checked: boolean
  /** 管理后台是否打开了识别限制。关闭时客户端不要拦密码账号，也不要按余额拦截。 */
  restricted: boolean
}

export type CheckInResult = PointsSummary & {
  granted_daily: number
  granted_streak: number
  message: string
}

/** 有结果才扣。0 秒、0 条不扣。向上取整，至少 1 分。 */
export function pointsForSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.max(1, Math.ceil(seconds / 2))
}

export function pointsForRows(count: number) {
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.max(1, Math.ceil(count / 2))
}

/** 文本整理调用前的冻结额：按非空行，至少 1 分。空白文本返回 0。 */
export function estimateTextPoints(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return 0
  return Math.max(1, Math.ceil(lines.length / 2))
}

/** 可入账条数：方向不是忽略，且不是解析失败的行。 */
export function payableRowCount(items: { status?: string; direction?: string }[]) {
  return items.filter((row) => row.direction !== 'skip' && row.status !== 'error' && row.status !== 'skip').length
}

/**
 * 与登录会话里的 wechat_bound 用同一条关联：身份表的 user_id 对用户主键，
 * 不用参数直接比身份表，避免两边类型不一致时登录显示已绑微信、积分却判成不是。
 * 微信新建的账号用户名是 wx_ 且没有密码；身份行没写上时仍算微信用户。
 */
export async function isWechatUser(db: Db, userId: number) {
  const row = await db.first(
    `SELECT 1 AS ok FROM users
     WHERE id = ?
       AND (
         EXISTS (
           SELECT 1 FROM user_identities i
           WHERE i.provider = ? AND i.user_id = users.id
         )
         OR (password_hash IS NULL AND username LIKE 'wx_%')
       )`,
    [userId, WECHAT],
  )
  return !!row
}

export async function getBalance(db: Db, userId: number) {
  const row = await db.first<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, [userId])
  return Number(row?.balance ?? 0)
}

const RECOGNITION_KEY = 'recognition.restricted'

/** 未配置时不限制。管理后台打开后，语音、拍照和文本整理才要求微信登录并扣积分。 */
export async function recognitionRestricted(db: Db) {
  const row = await db.first<{ value: string }>(`SELECT value FROM app_configs WHERE key = ?`, [RECOGNITION_KEY])
  return row?.value === '1'
}

export async function setRecognitionRestricted(db: Db, restricted: boolean) {
  const now = Date.now()
  await db.run(
    `INSERT INTO app_configs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [RECOGNITION_KEY, restricted ? '1' : '0', now],
  )
  return { restricted }
}

export async function assertWechatRecognition(db: Db, userId: number) {
  if (!(await recognitionRestricted(db))) return
  if (!(await isWechatUser(db, userId))) {
    throw forbidden('语音识别、图片识别和文本整理仅支持微信登录')
  }
}

export function speechSeconds(byteLength: number, durationMs: unknown) {
  let claimed = 0
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    claimed = Math.ceil(durationMs / 1000)
  } else if (typeof durationMs === 'string' && /^\d+$/.test(durationMs.trim())) {
    claimed = Math.ceil(Number(durationMs.trim()) / 1000)
  }
  if (claimed < 1) claimed = 1
  if (claimed > 60) claimed = 60
  // 48kbps 约 6000 字节/秒。声称的秒数明显短于文件时，按文件抬高，避免把长录音报成 1 秒。
  const fromSize = Math.ceil(byteLength / 6000)
  if (fromSize > claimed * 2) claimed = Math.min(60, fromSize)
  return claimed
}

/**
 * 积分上线前注册的微信账号没有注册赠送，积分页会是空的。
 * 已经有过积分明细的不再补，避免和后来手工分配的分数叠在一起。
 */
export async function grantMissingSignups(db: Db, now = Date.now()) {
  const users = await db.all<{ username: string }>(
    `SELECT u.username
     FROM users u
     WHERE (
       EXISTS (
         SELECT 1 FROM user_identities i
         WHERE i.provider = ? AND i.user_id = u.id
       )
       OR (u.password_hash IS NULL AND u.username LIKE 'wx_%')
     )
     AND NOT EXISTS (SELECT 1 FROM point_entries e WHERE e.user_id = u.id)`,
    [WECHAT],
  )
  for (const user of users) {
    await db.batch(signupGrantStmts(user.username, now))
  }
  return users.length
}

/** 微信账号创建成功时放进同一个 batch。业务单号按用户主键，重复创建不会再送 10 分。 */
export function signupGrantStmts(username: string, now: number): Stmt[] {
  return [
    {
      sql: `INSERT INTO point_accounts (user_id, balance, updated_at)
            SELECT id, 0, ? FROM users WHERE username = ?
            ON CONFLICT(user_id) DO NOTHING`,
      params: [now, username],
    },
    {
      sql: `UPDATE point_accounts
            SET balance = balance + ?, updated_at = ?
            WHERE user_id = (SELECT id FROM users WHERE username = ?)
              AND NOT EXISTS (
                SELECT 1 FROM point_entries
                WHERE biz_key = 'signup:' || (SELECT id FROM users WHERE username = ?)
              )`,
      params: [SIGNUP_POINTS, now, username, username],
    },
    {
      sql: `INSERT INTO point_entries (user_id, delta, balance_after, kind, note, biz_key, created_at)
            SELECT user_id, ?, balance, 'signup_grant', '注册赠送', 'signup:' || user_id, ?
            FROM point_accounts
            WHERE user_id = (SELECT id FROM users WHERE username = ?) AND changes() = 1`,
      params: [SIGNUP_POINTS, now, username],
    },
  ]
}

export async function pointsSummary(db: Db, userId: number, now = Date.now()): Promise<PointsSummary> {
  const restricted = await recognitionRestricted(db)
  const wechat = await isWechatUser(db, userId)
  if (!wechat) return { wechat: false, balance: 0, streak: 0, today_checked: false, restricted }
  const day = shanghaiDate(now)
  const checkin = await db.first<{ last_day: string; streak: number }>(
    `SELECT last_day, streak FROM point_checkins WHERE user_id = ?`,
    [userId],
  )
  return {
    wechat: true,
    balance: await getBalance(db, userId),
    streak: Number(checkin?.streak ?? 0),
    today_checked: checkin?.last_day === day,
    restricted,
  }
}

export async function listPointViews(db: Db, userId: number, limit = 50): Promise<PointView[]> {
  const rows = await db.all<{
    id: number
    delta: number
    balance_after: number
    kind: string
    note: string
    created_at: number
  }>(
    `SELECT id, delta, balance_after, kind, note, created_at
     FROM point_entries
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [userId, limit],
  )
  return rows.map((row) => ({
    id: Number(row.id),
    delta: Number(row.delta),
    balance_after: Number(row.balance_after),
    kind: row.kind,
    title: KIND_LABEL[row.kind] || row.kind,
    note: row.note,
    created_at: Number(row.created_at),
    time: shanghaiClock(row.created_at),
  }))
}

/**
 * 小程序当天第一次进入。网页调用不会进到这里。
 * 连续满 5、10、15… 天时，当天再加 2 分。同一天重复调用不再发。
 */
export async function checkIn(db: Db, userId: number, now = Date.now()): Promise<CheckInResult> {
  const summary = await pointsSummary(db, userId, now)
  if (!summary.wechat) {
    return { ...summary, granted_daily: 0, granted_streak: 0, message: '' }
  }
  if (summary.today_checked) {
    return { ...summary, granted_daily: 0, granted_streak: 0, message: '' }
  }
  const day = shanghaiDate(now)
  const prev = await db.first<{ last_day: string; streak: number }>(
    `SELECT last_day, streak FROM point_checkins WHERE user_id = ?`,
    [userId],
  )
  const streak = prev?.last_day === addDays(day, -1) ? Number(prev.streak) + 1 : 1
  const bonus = streak % 5 === 0 ? 2 : 0
  const stmts: Stmt[] = [
    {
      sql: `INSERT INTO point_checkins (user_id, last_day, streak, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              last_day = excluded.last_day,
              streak = excluded.streak,
              updated_at = excluded.updated_at
            WHERE point_checkins.last_day != excluded.last_day`,
      params: [userId, day, streak, now],
    },
    ...deltaStmts(userId, 1, 'daily_enter', day, `daily:${userId}:${day}`, now),
  ]
  if (bonus) {
    stmts.push(
      ...deltaStmts(userId, bonus, 'streak_bonus', `连续 ${streak} 天，本轮按 7 分发放`, `streak:${userId}:${day}`, now),
    )
  }
  const written = await db.batch(stmts)
  const grantedDaily = written[3]?.lastId != null ? 1 : 0
  const grantedStreak = bonus && written[6]?.lastId != null ? bonus : 0
  const balance = await getBalance(db, userId)
  const message = grantedStreak
    ? `连续进入 ${streak} 天，这 5 天按 7 天发放，额外 +2，今日共 +3`
    : grantedDaily
      ? '今日进入 +1'
      : ''
  return {
    wechat: true,
    balance,
    streak: grantedDaily || grantedStreak ? streak : summary.streak,
    today_checked: true,
    restricted: summary.restricted,
    granted_daily: grantedDaily,
    granted_streak: grantedStreak,
    message,
  }
}

export async function reserveCall(db: Db, userId: number, kind: 'speech' | 'image' | 'text') {
  const day = shanghaiDate()
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM point_calls WHERE user_id = ? AND kind = ? AND day = ?`,
    [userId, kind, day],
  )
  if (Number(row?.n ?? 0) >= DAILY_CALL_LIMIT) throw badRequest('今天这次识别次数已用完')
  await db.run(
    `INSERT INTO point_calls (user_id, kind, day, created_at) VALUES (?, ?, ?, ?)`,
    [userId, kind, day, Date.now()],
  )
}

export async function lackMessage(db: Db, userId: number, need: number, balance: number) {
  const summary = await pointsSummary(db, userId)
  const lack = Math.max(0, need - balance)
  const tail = summary.today_checked ? '今日进入积分已领取' : '今日进入积分还未领取'
  return `这段需要 ${need} 积分，还差 ${lack}。${tail}`
}

export function insufficient(message: string) {
  return new HttpError(402, 'insufficient_points', message)
}

/**
 * 文本或图片整理：先按预估冻结，成功后按可入账条数多退少补。失败把冻结全额退回。
 * run 抛错时也会退回。
 */
export async function chargeByRows<T>(
  db: Db,
  userId: number,
  kind: 'text' | 'image',
  quota: 'text' | 'image',
  estimate: number,
  run: () => Promise<{ rows: number; value: T }>,
): Promise<{ value: T; charged: number; balance: number }> {
  if (!(await recognitionRestricted(db))) {
    const result = await run()
    return { value: result.value, charged: 0, balance: await getBalance(db, userId) }
  }
  await assertWechatRecognition(db, userId)
  if (estimate < 1) throw badRequest('没有可整理的文字')
  const balance = await getBalance(db, userId)
  if (balance < estimate) throw insufficient(await lackMessage(db, userId, estimate, balance))
  await reserveCall(db, userId, quota)
  const key = crypto.randomUUID()
  const held = await applyDelta(db, userId, -estimate, kind, `冻结 ${estimate} 分`, `${kind}:${key}:hold`)
  if (!held.ok) throw insufficient(await lackMessage(db, userId, estimate, held.balance))
  try {
    const result = await run()
    const actual = pointsForRows(result.rows)
    let charged = estimate
    if (actual === estimate) {
      await db.run(`UPDATE point_entries SET note = ? WHERE biz_key = ?`, [`${result.rows} 条`, `${kind}:${key}:hold`])
    } else if (actual < estimate) {
      await applyDelta(
        db,
        userId,
        estimate - actual,
        'refund',
        actual === 0 ? '没有可入账记录，预估已退回' : '多冻退回',
        `${kind}:${key}:refund`,
      )
      charged = actual
    } else if (actual > estimate) {
      const extra = Math.min(actual - estimate, await getBalance(db, userId))
      if (extra > 0) {
        const added = await applyDelta(db, userId, -extra, kind, `${result.rows} 条`, `${kind}:${key}:extra`)
        if (added.ok) charged += extra
      }
    }
    return { value: result.value, charged, balance: await getBalance(db, userId) }
  } catch (error) {
    await applyDelta(db, userId, estimate, 'refund', '识别失败，预估已退回', `${kind}:${key}:refund`)
    throw error
  }
}

async function applyDelta(
  db: Db,
  userId: number,
  delta: number,
  kind: PointKind,
  note: string,
  bizKey: string,
) {
  const now = Date.now()
  const existing = await db.first(`SELECT id FROM point_entries WHERE biz_key = ?`, [bizKey])
  if (existing) return { ok: false, balance: await getBalance(db, userId) }
  const written = await db.batch(deltaStmts(userId, delta, kind, note, bizKey, now))
  if (written[2]?.lastId == null) return { ok: false, balance: await getBalance(db, userId) }
  return { ok: true, balance: await getBalance(db, userId) }
}

/** 语音识别在转写成功后按秒扣。限制关闭时不扣。调用前要先确认余额够。 */
export async function chargeSpeech(db: Db, userId: number, seconds: number) {
  if (!(await recognitionRestricted(db))) {
    return { charged: 0, balance: await getBalance(db, userId) }
  }
  const cost = pointsForSeconds(seconds)
  const balance = await getBalance(db, userId)
  if (balance < cost) throw insufficient(await lackMessage(db, userId, cost, balance))
  const applied = await applyDelta(db, userId, -cost, 'speech', `${seconds} 秒`, `speech:${crypto.randomUUID()}`)
  if (!applied.ok) throw insufficient(await lackMessage(db, userId, cost, applied.balance))
  return { charged: cost, balance: applied.balance }
}

function deltaStmts(userId: number, delta: number, kind: string, note: string, bizKey: string, now: number): Stmt[] {
  return [
    {
      sql: `INSERT INTO point_accounts (user_id, balance, updated_at) VALUES (?, 0, ?)
            ON CONFLICT(user_id) DO NOTHING`,
      params: [userId, now],
    },
    {
      sql: `UPDATE point_accounts
            SET balance = balance + ?, updated_at = ?
            WHERE user_id = ?
              AND NOT EXISTS (SELECT 1 FROM point_entries WHERE biz_key = ?)
              AND (? >= 0 OR balance + ? >= 0)`,
      params: [delta, now, userId, bizKey, delta, delta],
    },
    {
      sql: `INSERT INTO point_entries (user_id, delta, balance_after, kind, note, biz_key, created_at)
            SELECT user_id, ?, balance, ?, ?, ?, ?
            FROM point_accounts
            WHERE user_id = ? AND changes() = 1`,
      params: [delta, kind, note, bizKey, now, userId],
    },
  ]
}

function shanghaiClock(ms: number) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

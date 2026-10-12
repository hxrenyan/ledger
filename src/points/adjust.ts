import type { Db, Stmt } from '../db/types.ts'
import { badRequest, notFound } from '../http.ts'

/** 单次手动分配的绝对值上限，避免填错一个数量级。 */
const DELTA_LIMIT = 100_000
/** 一次批量分配的人数上限。 */
const BATCH_LIMIT = 100

const WECHAT = 'wechat'

export type PointEntry = {
  id: number
  user_id: number | string
  delta: number
  balance_after: number
  kind: 'admin_grant' | 'admin_deduct'
  note: string
  created_at: number
}

export type WechatPointUser = {
  id: number | string
  username: string
  nickname: string
  disabled: boolean
  balance: number
  updated_at: number | null
}

/**
 * 管理员给一位微信用户加减积分。
 * 正数记 admin_grant，负数记 admin_deduct。
 */
export async function adjustPoints(db: Db, userId: number | string, delta: number, note: string): Promise<PointEntry> {
  const [entry] = await adjustPointsMany(db, [userId], delta, note)
  return entry
}

/**
 * 同一变动、同一备注分配给多位微信用户。
 * 任何人不能分配时，整批不写入。
 */
export async function adjustPointsMany(db: Db, userIds: (number | string)[], delta: number, note: string): Promise<PointEntry[]> {
  const text = assertDeltaAndNote(delta, note)
  if (userIds.length === 0) throw badRequest('请选择用户')
  if (userIds.length > BATCH_LIMIT) throw badRequest('一次最多分配 100 位用户')
  if (new Set(userIds).size !== userIds.length) throw badRequest('用户不能重复')

  const placeholders = userIds.map(() => '?').join(', ')
  const rows = await db.all<{
    id: number
    nickname: string
    username: string
    wechat: number
    balance: number
  }>(
    `SELECT u.id, u.nickname, u.username,
            EXISTS(SELECT 1 FROM user_identities i WHERE i.provider = ? AND i.user_id = u.id) AS wechat,
            COALESCE(p.balance, 0) AS balance
     FROM users u
     LEFT JOIN point_accounts p ON p.user_id = u.id
     WHERE u.id IN (${placeholders})`,
    [WECHAT, ...userIds],
  )
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  if (userIds.some((id) => !byId.has(String(id)))) throw notFound('用户不存在')
  if (userIds.some((id) => Number(byId.get(String(id))?.wechat) !== 1)) {
    throw badRequest(userIds.length === 1 ? '该账号没有微信登录，不能分配积分' : '有账号没有微信登录，不能分配积分')
  }
  if (delta < 0) {
    const short = userIds.filter((id) => Number(byId.get(String(id))?.balance) + delta < 0)
    if (short.length) {
      if (userIds.length === 1) throw badRequest('扣减后余额不能小于 0')
      const names = short.map((id) => displayName(byId.get(String(id)))).join('、')
      throw badRequest(`这些账号扣减后余额会小于 0：${names}，这次没有分配`)
    }
  }

  const now = Date.now()
  const kind = delta > 0 ? 'admin_grant' : 'admin_deduct'
  const floor = await db.first<{ id: number }>(`SELECT COALESCE(MAX(id), 0) AS id FROM point_entries`)
  const floorId = Number(floor?.id ?? 0)
  const stmts: Stmt[] = []
  for (const userId of userIds) {
    stmts.push(
      {
        sql: `INSERT INTO point_accounts (user_id, balance, updated_at) VALUES (?, 0, ?)
              ON CONFLICT(user_id) DO NOTHING`,
        params: [userId, now],
      },
      {
        sql: `UPDATE point_accounts
              SET balance = balance + ?, updated_at = ?
              WHERE user_id = ? AND balance + ? >= 0`,
        params: [delta, now, userId, delta],
      },
      {
        sql: `INSERT INTO point_entries (user_id, delta, balance_after, kind, note, created_at)
              SELECT user_id, ?, balance, ?, ?, ?
              FROM point_accounts
              WHERE user_id = ? AND changes() = 1`,
        params: [delta, kind, text, now, userId],
      },
    )
  }
  // 人数对不上就插入空行触发约束失败，整批回滚。正常时这条 WHERE 不成立，不会写入。
  stmts.push({
    sql: `INSERT INTO point_entries (user_id, delta, balance_after, kind, note, created_at)
          SELECT NULL, NULL, NULL, NULL, NULL, NULL
          WHERE (
            SELECT COUNT(*) FROM point_entries
            WHERE id > ? AND created_at = ? AND delta = ? AND user_id IN (${placeholders})
          ) != ?`,
    params: [floorId, now, delta, ...userIds, userIds.length],
  })

  let written: { lastId: number | null }[]
  try {
    written = await db.batch(stmts)
  } catch (e) {
    if (e instanceof Error && e.message.includes('NOT NULL')) {
      throw badRequest(userIds.length === 1 ? '扣减后余额不能小于 0' : '有用户扣减后余额会小于 0，这次没有分配')
    }
    throw e
  }

  const entryIds = userIds.map((_, index) => written[index * 3 + 2]?.lastId ?? null)
  if (entryIds.some((id) => id == null)) {
    throw badRequest(userIds.length === 1 ? '扣减后余额不能小于 0' : '有用户扣减后余额会小于 0，这次没有分配')
  }
  const loaded = await db.all<PointEntry>(
    `SELECT id, user_id, delta, balance_after, kind, note, created_at
     FROM point_entries
     WHERE id IN (${entryIds.map(() => '?').join(', ')})`,
    entryIds,
  )
  const entryByUser = new Map(loaded.map((row) => [String(row.user_id), normalizeEntry(row)]))
  return userIds.map((userId) => {
    const entry = entryByUser.get(String(userId))
    if (!entry) throw badRequest('分配结果不完整，请重试')
    return entry
  })
}

function assertDeltaAndNote(delta: number, note: string) {
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > DELTA_LIMIT) {
    throw badRequest('积分变动须为非 0 整数，且绝对值不超过 100000')
  }
  const text = note.trim()
  if (!text || text.length > 100) throw badRequest('备注须为 1–100 字')
  return text
}

function displayName(row: { nickname: string; username: string } | undefined) {
  const name = row?.nickname?.trim() || row?.username || ''
  return name
}

function normalizeEntry(row: PointEntry): PointEntry {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    delta: Number(row.delta),
    balance_after: Number(row.balance_after),
    kind: row.kind,
    note: row.note,
    created_at: Number(row.created_at),
  }
}

/** 没有微信身份的账号不能有积分。用户不存在和「不是微信用户」分开返回。 */
export async function assertWechatUser(db: Db, userId: number | string) {
  const user = await db.first<{ id: number }>(
    `SELECT u.id
     FROM users u
     JOIN user_identities i ON i.user_id = u.id AND i.provider = ?
     WHERE u.id = ?`,
    [WECHAT, userId],
  )
  if (user) return
  const exists = await db.first(`SELECT id FROM users WHERE id = ?`, [userId])
  if (!exists) throw notFound('用户不存在')
  throw badRequest('该账号没有微信登录，不能分配积分')
}

/** 管理后台积分页：只列出有微信身份的账号。like 为空时不做昵称或账号筛选。 */
export async function listWechatPointUsers(db: Db, like: string | null = null): Promise<WechatPointUser[]> {
  const pattern = like ?? ''
  const rows = await db.all<{
    id: number
    username: string
    nickname: string
    disabled: number
    balance: number
    updated_at: number | null
  }>(
    `SELECT u.id, u.username, u.nickname, u.disabled, COALESCE(p.balance, 0) AS balance, p.updated_at
     FROM users u
     JOIN user_identities i ON i.user_id = u.id AND i.provider = ?
     LEFT JOIN point_accounts p ON p.user_id = u.id
     WHERE (? = '' OR u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')
     ORDER BY u.created_at DESC`,
    [WECHAT, pattern, pattern, pattern],
  )
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    disabled: !!row.disabled,
    balance: Number(row.balance),
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
  }))
}

/** 某个用户最近的积分明细，新的在前。 */
export async function listPointEntries(db: Db, userId: number | string, limit = 20): Promise<PointEntry[]> {
  const rows = await db.all<PointEntry>(
    `SELECT id, user_id, delta, balance_after, kind, note, created_at
     FROM point_entries
     WHERE user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [userId, limit],
  )
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
    user_id: Number(row.user_id),
    delta: Number(row.delta),
    balance_after: Number(row.balance_after),
    created_at: Number(row.created_at),
  }))
}

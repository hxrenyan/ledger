import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/types.ts'
import { badRequest, unauthorized } from '../http.ts'

const TTL_MS = 5 * 60 * 1000

/** 签发一次性交接码。明文只出现在返回值里，库里存 SHA-256。 */
export async function issueHandoff(db: Db, userId: number, ledgerId: number) {
  const now = Date.now()
  await db.run(`DELETE FROM handoff_codes WHERE expires_at < ?`, [now])
  const code = randomBytes(24).toString('hex')
  const hash = sha256(code)
  await db.run(
    `INSERT INTO handoff_codes (code_hash, user_id, ledger_id, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [hash, userId, ledgerId, now + TTL_MS, now],
  )
  return { code, expires_in: 300 }
}

/** 兑换交接码。用过、过期、形状不对都进不来。UPDATE ... RETURNING 保证并发下只成功一次。 */
export async function redeemHandoff(db: Db, raw: unknown) {
  const code = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{48}$/.test(code)) throw badRequest('交接码无效')
  const now = Date.now()
  const row = await db.first<{ user_id: number; ledger_id: number }>(
    `UPDATE handoff_codes SET used_at = ?
     WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?
     RETURNING user_id, ledger_id`,
    [now, sha256(code), now],
  )
  if (!row) throw unauthorized('交接码已失效')
  if (row.ledger_id > 0) {
    const member = await db.first(
      `SELECT role FROM members WHERE ledger_id = ? AND user_id = ?`,
      [row.ledger_id, row.user_id],
    )
    if (!member) throw unauthorized('账本已失效')
  }
  return row
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

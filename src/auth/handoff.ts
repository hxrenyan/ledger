/**
 * 一次性会话交接码：小程序原生 → web-view 网页。
 *
 * 为什么需要它：web-view 里的网页没有 wx.login，拿不到 code，
 * 现有「wx.login → /auth/wechat」那条链路在网页里直接断掉。
 * 所以由原生侧（已登录）换一个短命的一次性 code 交给网页，网页再用它换回会话。
 *
 * 安全约定：
 * - 明文 code 只在签发响应里出现一次，库里只存 SHA-256。
 * - 5 分钟过期，用一次即失效（靠 UPDATE ... RETURNING 原子抢占，防并发重放）。
 * - 不做「同域 cookie 共享」：网页与 API 同域时 cookie 会被带上，
 *   但我们要支持以后 API 换域名（迁到自己的服务器），所以坚持显式交接。
 */

import type { Db } from '../db/types.ts'
import { badRequest } from '../http.ts'

/** 交接码有效期：够网页加载完就行，别给太久。 */
export const HANDOFF_TTL_MS = 5 * 60 * 1000

const CODE_BYTES = 24
/** 24 字节 → 48 位十六进制。 */
const CODE_LEN = CODE_BYTES * 2
const HEX_RE = /^[0-9a-f]+$/

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** 明文交接码：32 位十六进制以上，不可枚举。 */
export function newHandoffCode(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(CODE_BYTES)))
}

export async function hashHandoffCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return toHex(new Uint8Array(digest))
}

/** 校验请求里带过来的 code，形状不对直接挡掉，不进库查询。 */
export function assertHandoffCode(input: unknown): string {
  if (typeof input !== 'string') throw new Error('缺少交接码')
  const code = input.trim()
  if (code.length !== CODE_LEN || !HEX_RE.test(code)) throw new Error('交接码无效')
  return code
}

/**
 * 签发。顺带清掉已过期的码——数量极小，不需要独立定时任务。
 * ledgerId 允许为空：网页端没有账本归属时会退回用户的第一个账本。
 */
export async function issueHandoff(
  db: Db,
  input: { userId: string; ledgerId?: string; now?: number },
): Promise<{ code: string; expires_in: number }> {
  const now = input.now ?? Date.now()
  const code = newHandoffCode()
  const codeHash = await hashHandoffCode(code)
  await db.batch([
    { sql: `DELETE FROM handoff_codes WHERE expires_at < ?`, params: [now] },
    {
      sql: `INSERT INTO handoff_codes (code_hash, user_id, ledger_id, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [codeHash, input.userId, input.ledgerId ?? '', now + HANDOFF_TTL_MS, now],
    },
  ])
  return { code, expires_in: Math.floor(HANDOFF_TTL_MS / 1000) }
}

/**
 * 兑换。用 UPDATE ... RETURNING 一句话完成「校验未过期 + 未使用 + 标记已用」，
 * 并发重复兑换时只有一个能拿到返回行，避免 TOCTOU。
 */
export async function redeemHandoff(
  db: Db,
  code: string,
  now = Date.now(),
): Promise<{ userId: string; ledgerId: string } | null> {
  const codeHash = await hashHandoffCode(code)
  const row = await db.first<{ user_id: string; ledger_id: string }>(
    `UPDATE handoff_codes SET used_at = ?
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING user_id, ledger_id`,
    [now, codeHash, now],
  )
  if (!row) return null
  return { userId: row.user_id, ledgerId: row.ledger_id ?? '' }
}

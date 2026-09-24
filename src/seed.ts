import type { Stmt } from './db/types.ts'

const DEFAULT_ACCOUNTS: { name: string; type: string }[] = [
  { name: '现金', type: 'cash' },
  { name: '支付宝', type: 'alipay' },
  { name: '微信', type: 'wechat' },
  { name: '银行卡', type: 'bank' },
]

const DEFAULT_CATEGORIES: { name: string; kind: 'expense' | 'income' }[] = [
  { name: '餐饮', kind: 'expense' },
  { name: '交通', kind: 'expense' },
  { name: '购物', kind: 'expense' },
  { name: '房租', kind: 'expense' },
  { name: '水电', kind: 'expense' },
  { name: '娱乐', kind: 'expense' },
  { name: '医疗', kind: 'expense' },
  { name: '教育', kind: 'expense' },
  { name: '其他', kind: 'expense' },
  { name: '工资', kind: 'income' },
  { name: '奖金', kind: 'income' },
  { name: '兼职', kind: 'income' },
  { name: '红包', kind: 'income' },
  { name: '其他', kind: 'income' },
]

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let out = ''
  for (const b of bytes) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length]
  return out
}

/**
 * 注册：用户和默认账本同一批写入。用户 id 还不知道，账本主人用 username 回查。
 * 调用方提交后按 username 取用户 id。
 */
export function bootstrapLedgerStmts(opts: {
  username: string
  nickname: string
  passwordHash: string | null
  now: number
}): { stmts: Stmt[] } {
  const ledger = ledgerOnlyStmts({
    username: opts.username,
    name: `${opts.nickname}的账本`,
    now: opts.now,
  })
  return {
    stmts: [
      {
        sql: `INSERT INTO users (username, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)`,
        params: [opts.username, opts.passwordHash, opts.nickname, opts.now],
      },
      ...ledger.stmts,
    ],
  }
}

/**
 * 建账本和默认账户/分类。已有用户传 userId；跟用户插入放在同一批时传 username。
 * 子表不预生成主键，用邀请码把刚插入的账本找回来。调用方提交后按 inviteCode 取账本 id。
 */
export function ledgerOnlyStmts(opts: {
  userId?: number
  username?: string
  name: string
  now: number
}): { stmts: Stmt[]; inviteCode: string } {
  if (opts.userId == null && !opts.username) throw new Error('缺少账本主人')
  const inviteCode = randomInviteCode()
  const ownerExpr = opts.userId != null ? '?' : '(SELECT id FROM users WHERE username = ?)'
  const ownerParam = opts.userId != null ? opts.userId : opts.username
  const stmts: Stmt[] = [
    {
      sql: `INSERT INTO ledgers (name, owner_id, invite_code, created_at) VALUES (?, ${ownerExpr}, ?, ?)`,
      params: [opts.name, ownerParam, inviteCode, opts.now],
    },
    {
      sql: `INSERT INTO members (ledger_id, user_id, role, created_at)
            SELECT id, owner_id, 'owner', ? FROM ledgers WHERE invite_code = ?`,
      params: [opts.now, inviteCode],
    },
  ]

  DEFAULT_ACCOUNTS.forEach((a, i) => {
    stmts.push({
      sql: `INSERT INTO accounts (ledger_id, name, type, sort_order, archived, current_cents, created_at)
            SELECT id, ?, ?, ?, 0, 0, ? FROM ledgers WHERE invite_code = ?`,
      params: [a.name, a.type, i, opts.now, inviteCode],
    })
  })

  DEFAULT_CATEGORIES.forEach((c, i) => {
    stmts.push({
      sql: `INSERT INTO categories (ledger_id, name, kind, sort_order, archived, created_at)
            SELECT id, ?, ?, ?, 0, ? FROM ledgers WHERE invite_code = ?`,
      params: [c.name, c.kind, i, opts.now, inviteCode],
    })
  })

  return { stmts, inviteCode }
}

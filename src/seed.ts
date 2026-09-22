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

export function newId(): string {
  return crypto.randomUUID()
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let out = ''
  for (const b of bytes) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length]
  return out
}

export function bootstrapLedgerStmts(opts: {
  userId: string
  username: string
  nickname: string
  passwordHash: string
  now: number
}): { stmts: Stmt[]; ledgerId: string; userId: string } {
  const { userId, username, nickname, passwordHash, now } = opts
  const { stmts: ledgerStmts, ledgerId } = ledgerOnlyStmts({
    userId,
    name: `${nickname}的账本`,
    now,
  })
  const stmts: Stmt[] = [
    {
      sql: `INSERT INTO users (id, username, password_hash, nickname, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [userId, username, passwordHash, nickname, now],
    },
    ...ledgerStmts,
  ]
  return { stmts, ledgerId, userId }
}

export function ledgerOnlyStmts(opts: {
  userId: string
  name: string
  now: number
}): { stmts: Stmt[]; ledgerId: string } {
  const { userId, name, now } = opts
  const ledgerId = newId()
  const stmts: Stmt[] = [
    {
      sql: `INSERT INTO ledgers (id, name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)`,
      params: [ledgerId, name, userId, randomInviteCode(), now],
    },
    {
      sql: `INSERT INTO members (ledger_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
      params: [ledgerId, userId, 'owner', now],
    },
  ]

  DEFAULT_ACCOUNTS.forEach((a, i) => {
    stmts.push({
      sql: `INSERT INTO accounts (id, ledger_id, name, type, sort_order, archived, current_cents, created_at)
            VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      params: [newId(), ledgerId, a.name, a.type, i, now],
    })
  })

  DEFAULT_CATEGORIES.forEach((c, i) => {
    stmts.push({
      sql: `INSERT INTO categories (id, ledger_id, name, kind, sort_order, archived, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)`,
      params: [newId(), ledgerId, c.name, c.kind, i, now],
    })
  })

  return { stmts, ledgerId }
}

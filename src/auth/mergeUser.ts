import type { Db, Stmt } from '../db/types.ts'

const WECHAT = 'wechat'

/**
 * 把 source 并进 target，调用方放进同一个 batch。
 * 身份先改挂到 target。后面的语句都要求这行已经挂过去，没挂上就整批等于没写。
 * 只有 source 一个人的账本折进 target 最早的自有账本；同名账户、分类、联系人合并，余额和预算相加。
 * 还有别人的账本不搬流水，只把所有权或成员身份交给 target，避免把家庭账本拆进私人账本。
 */
export async function mergeUserStmts(
  db: Db,
  sourceUserId: number,
  targetUserId: number,
  openid: string,
): Promise<Stmt[]> {
  const guard = `EXISTS (SELECT 1 FROM user_identities WHERE provider = ? AND openid = ? AND user_id = ?)`
  const guardParams = [WECHAT, openid, targetUserId]
  const stmts: Stmt[] = [
    {
      sql: `UPDATE user_identities SET user_id = ? WHERE provider = ? AND openid = ? AND user_id = ?`,
      params: [targetUserId, WECHAT, openid, sourceUserId],
    },
  ]

  const targetOwned = await db.all<{ id: number }>(
    `SELECT id FROM ledgers WHERE owner_id = ? ORDER BY created_at ASC, id ASC`,
    [targetUserId],
  )
  const sourceOwned = await db.all<{ id: number }>(
    `SELECT id FROM ledgers WHERE owner_id = ? ORDER BY created_at ASC, id ASC`,
    [sourceUserId],
  )
  const destLedgerId = targetOwned[0]?.id ?? null
  const ownedIds = new Set(sourceOwned.map((row) => row.id))

  for (const ledger of sourceOwned) {
    const others = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM members WHERE ledger_id = ? AND user_id != ?`,
      [ledger.id, sourceUserId],
    )
    if (destLedgerId && Number(others?.n ?? 0) === 0) {
      stmts.push(...(await foldLedgerStmts(db, ledger.id, destLedgerId, sourceUserId, guard, guardParams)))
    } else {
      stmts.push(...transferOwnedLedger(ledger.id, sourceUserId, targetUserId, guard, guardParams))
    }
  }

  const memberships = await db.all<{ ledger_id: number }>(
    `SELECT ledger_id FROM members WHERE user_id = ?`,
    [sourceUserId],
  )
  for (const membership of memberships) {
    if (ownedIds.has(membership.ledger_id)) continue
    stmts.push(...transferMembership(membership.ledger_id, sourceUserId, targetUserId, guard, guardParams))
  }

  for (const table of ['transactions', 'gifts', 'import_batches']) {
    stmts.push({
      sql: `UPDATE ${table} SET created_by = ? WHERE created_by = ? AND ${guard}`,
      params: [targetUserId, sourceUserId, ...guardParams],
    })
  }
  stmts.push({
    sql: `DELETE FROM members WHERE user_id = ? AND ${guard}`,
    params: [sourceUserId, ...guardParams],
  })
  stmts.push({
    sql: `DELETE FROM users WHERE id = ? AND id != ? AND ${guard}`,
    params: [sourceUserId, targetUserId, ...guardParams],
  })
  return stmts
}

async function foldLedgerStmts(
  db: Db,
  sourceLedgerId: number,
  destLedgerId: number,
  sourceUserId: number,
  guard: string,
  guardParams: unknown[],
): Promise<Stmt[]> {
  const stmts: Stmt[] = []
  const accounts = await mergeAccounts(db, sourceLedgerId, destLedgerId, guard, guardParams)
  stmts.push(...accounts.stmts)
  const categories = await mergeCategories(db, sourceLedgerId, destLedgerId, guard, guardParams)
  stmts.push(...categories.stmts)
  stmts.push(...(await mergeBudgets(db, sourceLedgerId, destLedgerId, categories.map, guard, guardParams)))
  const contacts = await mergeContacts(db, sourceLedgerId, destLedgerId, guard, guardParams)
  stmts.push(...contacts)

  stmts.push(
    {
      sql: `UPDATE transactions SET ledger_id = ? WHERE ledger_id = ? AND ${guard}`,
      params: [destLedgerId, sourceLedgerId, ...guardParams],
    },
    {
      sql: `UPDATE gifts SET ledger_id = ? WHERE ledger_id = ? AND ${guard}`,
      params: [destLedgerId, sourceLedgerId, ...guardParams],
    },
    {
      sql: `UPDATE attachments SET ledger_id = ? WHERE ledger_id = ? AND ${guard}`,
      params: [destLedgerId, sourceLedgerId, ...guardParams],
    },
    {
      sql: `UPDATE recurrences SET ledger_id = ? WHERE ledger_id = ? AND ${guard}`,
      params: [destLedgerId, sourceLedgerId, ...guardParams],
    },
    {
      sql: `UPDATE import_batches SET ledger_id = ? WHERE ledger_id = ? AND ${guard}`,
      params: [destLedgerId, sourceLedgerId, ...guardParams],
    },
    {
      sql: `DELETE FROM members WHERE ledger_id = ? AND user_id = ? AND ${guard}`,
      params: [sourceLedgerId, sourceUserId, ...guardParams],
    },
    {
      sql: `DELETE FROM ledgers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM members m WHERE m.ledger_id = ledgers.id) AND ${guard}`,
      params: [sourceLedgerId, ...guardParams],
    },
  )
  return stmts
}

type IdRow = { id: number }

async function mergeAccounts(
  db: Db,
  sourceLedgerId: number,
  destLedgerId: number,
  guard: string,
  guardParams: unknown[],
): Promise<{ stmts: Stmt[] }> {
  const destRows = await db.all<{ id: number; name: string }>(
    `SELECT id, name FROM accounts WHERE ledger_id = ? ORDER BY archived ASC, sort_order ASC, created_at ASC`,
    [destLedgerId],
  )
  const sourceRows = await db.all<{ id: number; name: string; current_cents: number }>(
    `SELECT id, name, current_cents FROM accounts WHERE ledger_id = ? ORDER BY archived ASC, sort_order ASC, created_at ASC`,
    [sourceLedgerId],
  )
  const byName = indexBy(destRows, (row) => row.name)
  const stmts: Stmt[] = []
  for (const src of sourceRows) {
    const hit = byName.get(src.name)
    if (hit && hit.id !== src.id) {
      stmts.push(
        {
          sql: `UPDATE transactions SET account_id = ? WHERE account_id = ? AND ${guard}`,
          params: [hit.id, src.id, ...guardParams],
        },
        {
          sql: `UPDATE transactions SET to_account_id = ? WHERE to_account_id = ? AND ${guard}`,
          params: [hit.id, src.id, ...guardParams],
        },
        {
          sql: `UPDATE recurrences SET account_id = ? WHERE account_id = ? AND ${guard}`,
          params: [hit.id, src.id, ...guardParams],
        },
        {
          sql: `UPDATE accounts SET current_cents = current_cents + ? WHERE id = ? AND ${guard}`,
          params: [src.current_cents, hit.id, ...guardParams],
        },
        {
          sql: `DELETE FROM accounts WHERE id = ? AND ${guard}`,
          params: [src.id, ...guardParams],
        },
      )
      continue
    }
    stmts.push({
      sql: `UPDATE accounts SET ledger_id = ? WHERE id = ? AND ${guard}`,
      params: [destLedgerId, src.id, ...guardParams],
    })
    byName.set(src.name, { id: src.id, name: src.name })
  }
  return { stmts }
}

async function mergeCategories(
  db: Db,
  sourceLedgerId: number,
  destLedgerId: number,
  guard: string,
  guardParams: unknown[],
): Promise<{ stmts: Stmt[]; map: Map<number, number> }> {
  const destRows = await db.all<{ id: number; name: string; kind: string }>(
    `SELECT id, name, kind FROM categories WHERE ledger_id = ? ORDER BY archived ASC, sort_order ASC, created_at ASC`,
    [destLedgerId],
  )
  const sourceRows = await db.all<{ id: number; name: string; kind: string }>(
    `SELECT id, name, kind FROM categories WHERE ledger_id = ? ORDER BY archived ASC, sort_order ASC, created_at ASC`,
    [sourceLedgerId],
  )
  const byKey = indexBy(destRows, (row) => categoryKey(row.name, row.kind))
  const map = new Map<number, number>()
  const stmts: Stmt[] = []
  for (const src of sourceRows) {
    const hit = byKey.get(categoryKey(src.name, src.kind))
    const targetId = hit && hit.id !== src.id ? hit.id : src.id
    map.set(src.id, targetId)
    if (hit && hit.id !== src.id) {
      stmts.push(
        {
          sql: `UPDATE transactions SET category_id = ? WHERE category_id = ? AND ${guard}`,
          params: [hit.id, src.id, ...guardParams],
        },
        {
          sql: `UPDATE recurrences SET category_id = ? WHERE category_id = ? AND ${guard}`,
          params: [hit.id, src.id, ...guardParams],
        },
        {
          sql: `DELETE FROM categories WHERE id = ? AND ${guard}`,
          params: [src.id, ...guardParams],
        },
      )
      continue
    }
    stmts.push({
      sql: `UPDATE categories SET ledger_id = ? WHERE id = ? AND ${guard}`,
      params: [destLedgerId, src.id, ...guardParams],
    })
    byKey.set(categoryKey(src.name, src.kind), src)
  }
  return { stmts, map }
}

async function mergeBudgets(
  db: Db,
  sourceLedgerId: number,
  destLedgerId: number,
  categoryMap: Map<number, number>,
  guard: string,
  guardParams: unknown[],
): Promise<Stmt[]> {
  const destRows = await db.all<{ id: number; month: string; category_id: number; amount_cents: number }>(
    `SELECT id, month, category_id, amount_cents FROM budgets WHERE ledger_id = ?`,
    [destLedgerId],
  )
  const sourceRows = await db.all<{ id: number; month: string; category_id: number; amount_cents: number }>(
    `SELECT id, month, category_id, amount_cents FROM budgets WHERE ledger_id = ?`,
    [sourceLedgerId],
  )
  const destByKey = indexBy(destRows, (row) => budgetKey(row.month, row.category_id))
  const grouped = new Map<string, { categoryId: number; month: string; amount: number; ids: number[] }>()
  for (const row of sourceRows) {
    const categoryId = categoryMap.get(row.category_id) ?? row.category_id
    const key = budgetKey(row.month, categoryId)
    const found = grouped.get(key)
    if (found) {
      found.amount += Number(row.amount_cents)
      found.ids.push(row.id)
    } else {
      grouped.set(key, { categoryId, month: row.month, amount: Number(row.amount_cents), ids: [row.id] })
    }
  }
  const stmts: Stmt[] = []
  for (const [key, group] of grouped) {
    const hit = destByKey.get(key)
    if (hit) {
      stmts.push({
        sql: `UPDATE budgets SET amount_cents = amount_cents + ? WHERE id = ? AND ${guard}`,
        params: [group.amount, hit.id, ...guardParams],
      })
      for (const id of group.ids) {
        stmts.push({ sql: `DELETE FROM budgets WHERE id = ? AND ${guard}`, params: [id, ...guardParams] })
      }
      continue
    }
    const [keep, ...rest] = group.ids
    stmts.push({
      sql: `UPDATE budgets SET ledger_id = ?, category_id = ?, amount_cents = ? WHERE id = ? AND ${guard}`,
      params: [destLedgerId, group.categoryId, group.amount, keep, ...guardParams],
    })
    for (const id of rest) {
      stmts.push({ sql: `DELETE FROM budgets WHERE id = ? AND ${guard}`, params: [id, ...guardParams] })
    }
  }
  return stmts
}

async function mergeContacts(
  db: Db,
  sourceLedgerId: number,
  destLedgerId: number,
  guard: string,
  guardParams: unknown[],
): Promise<Stmt[]> {
  const destRows = await db.all<IdRow & { name: string }>(
    `SELECT id, name FROM contacts WHERE ledger_id = ? ORDER BY archived ASC, created_at ASC`,
    [destLedgerId],
  )
  const sourceRows = await db.all<IdRow & { name: string }>(
    `SELECT id, name FROM contacts WHERE ledger_id = ? ORDER BY archived ASC, created_at ASC`,
    [sourceLedgerId],
  )
  const byName = indexBy(destRows, (row) => row.name)
  const stmts: Stmt[] = []
  for (const src of sourceRows) {
    const hit = byName.get(src.name)
    if (hit && hit.id !== src.id) {
      stmts.push(
        {
          sql: `UPDATE gifts SET contact_id = ? WHERE contact_id = ? AND ${guard}`,
          params: [hit.id, src.id, ...guardParams],
        },
        {
          sql: `DELETE FROM contacts WHERE id = ? AND ${guard}`,
          params: [src.id, ...guardParams],
        },
      )
      continue
    }
    stmts.push({
      sql: `UPDATE contacts SET ledger_id = ? WHERE id = ? AND ${guard}`,
      params: [destLedgerId, src.id, ...guardParams],
    })
    byName.set(src.name, src)
  }
  return stmts
}

function transferOwnedLedger(
  ledgerId: number,
  sourceUserId: number,
  targetUserId: number,
  guard: string,
  guardParams: unknown[],
): Stmt[] {
  return [
    {
      sql: `UPDATE ledgers SET owner_id = ? WHERE id = ? AND owner_id = ? AND ${guard}`,
      params: [targetUserId, ledgerId, sourceUserId, ...guardParams],
    },
    ...transferMembership(ledgerId, sourceUserId, targetUserId, guard, guardParams),
    {
      sql: `UPDATE members SET role = 'owner' WHERE ledger_id = ? AND user_id = ? AND ${guard}`,
      params: [ledgerId, targetUserId, ...guardParams],
    },
  ]
}

function transferMembership(
  ledgerId: number,
  sourceUserId: number,
  targetUserId: number,
  guard: string,
  guardParams: unknown[],
): Stmt[] {
  return [
    {
      sql: `DELETE FROM members WHERE ledger_id = ? AND user_id = ?
            AND EXISTS (SELECT 1 FROM members m WHERE m.ledger_id = ? AND m.user_id = ?)
            AND ${guard}`,
      params: [ledgerId, sourceUserId, ledgerId, targetUserId, ...guardParams],
    },
    {
      sql: `UPDATE members SET user_id = ? WHERE ledger_id = ? AND user_id = ? AND ${guard}`,
      params: [targetUserId, ledgerId, sourceUserId, ...guardParams],
    },
  ]
}

function categoryKey(name: string, kind: string): string {
  return `${kind}\0${name}`
}

function budgetKey(month: string, categoryId: number): string {
  return `${month}\0${categoryId}`
}

function indexBy<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) {
    const id = key(row)
    if (!map.has(id)) map.set(id, row)
  }
  return map
}

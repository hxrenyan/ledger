import type { Stmt } from './db/types.ts'

export type TxMoney = {
  kind: string
  amount_cents: number
  account_id: string
  to_account_id: string | null
}

/** sign=1 入账，sign=-1 冲销。 */
export function balanceStmts(tx: TxMoney, sign: 1 | -1): Stmt[] {
  const n = sign * tx.amount_cents
  if (tx.kind === 'income') {
    return [{ sql: `UPDATE accounts SET current_cents = current_cents + ? WHERE id = ?`, params: [n, tx.account_id] }]
  }
  if (tx.kind === 'expense') {
    return [{ sql: `UPDATE accounts SET current_cents = current_cents + ? WHERE id = ?`, params: [-n, tx.account_id] }]
  }
  if (tx.kind === 'transfer' && tx.to_account_id) {
    return [
      { sql: `UPDATE accounts SET current_cents = current_cents + ? WHERE id = ?`, params: [-n, tx.account_id] },
      { sql: `UPDATE accounts SET current_cents = current_cents + ? WHERE id = ?`, params: [n, tx.to_account_id] },
    ]
  }
  return []
}

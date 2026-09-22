-- 账户余额、流水不计入收支、周期记账
ALTER TABLE accounts ADD COLUMN current_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS recurrences (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  to_account_id TEXT,
  category_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  day_of_month INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recurrences_next ON recurrences (ledger_id, enabled, next_at);

UPDATE accounts SET current_cents = (
  SELECT COALESCE(SUM(CASE
    WHEN t.kind = 'income' AND t.account_id = accounts.id THEN t.amount_cents
    WHEN t.kind = 'expense' AND t.account_id = accounts.id THEN -t.amount_cents
    WHEN t.kind = 'transfer' AND t.account_id = accounts.id THEN -t.amount_cents
    WHEN t.kind = 'transfer' AND t.to_account_id = accounts.id THEN t.amount_cents
    ELSE 0
  END), 0)
  FROM transactions t
  WHERE t.ledger_id = accounts.ledger_id
);

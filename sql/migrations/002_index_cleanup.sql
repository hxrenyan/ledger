-- 重整索引：删除旧形态后创建与现有查询条件匹配的联合索引。
-- 索引不参与业务数据迁移，全部语句可重复执行。

DROP INDEX IF EXISTS idx_tx_ledger_occurred;
CREATE INDEX IF NOT EXISTS idx_tx_ledger_occurred
  ON transactions (ledger_id, occurred_at, created_at);

DROP INDEX IF EXISTS idx_tx_ledger_category;

DROP INDEX IF EXISTS idx_contacts_ledger;
CREATE INDEX IF NOT EXISTS idx_contacts_ledger
  ON contacts (ledger_id, archived, name COLLATE NOCASE);

DROP INDEX IF EXISTS idx_gifts_contact;
CREATE INDEX IF NOT EXISTS idx_gifts_contact
  ON gifts (contact_id, ledger_id, occurred_at, created_at);

CREATE INDEX IF NOT EXISTS idx_gifts_ledger_occurred
  ON gifts (ledger_id, occurred_at, created_at);

DROP INDEX IF EXISTS idx_tx_import_batch;
CREATE INDEX IF NOT EXISTS idx_tx_import_batch
  ON transactions (ledger_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

DROP INDEX IF EXISTS idx_gifts_import_batch;
CREATE INDEX IF NOT EXISTS idx_gifts_import_batch
  ON gifts (ledger_id, import_batch_id, contact_id)
  WHERE import_batch_id IS NOT NULL;

DROP INDEX IF EXISTS idx_ai_profiles_order;
CREATE INDEX IF NOT EXISTS idx_ai_profiles_order
  ON ai_profiles (kind, sort_order, updated_at, id);

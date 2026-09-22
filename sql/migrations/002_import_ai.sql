-- 账单导入与 AI 配置
-- 1) transactions 增加 import_batch_id：标记流水来源批次，支持按批次撤销
-- 2) import_batches：导入批次台账
-- 3) ai_settings：管理后台配置的 AI 解析/分类模型（全局单行）

ALTER TABLE transactions ADD COLUMN import_batch_id TEXT;

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  source TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  parsed_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  ai_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);

CREATE TABLE IF NOT EXISTS ai_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_batches_ledger ON import_batches (ledger_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_import_batch ON transactions (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- 语音识别多套配置 + 人情往来可随导入批次撤销
-- 数据量：asr_profiles 新建空表；gifts 现有行 import_batch_id 为空（手工记账），撤销逻辑只碰非空批次。
-- 验证：PRAGMA table_info(asr_profiles) 含 sort_order/protocol；
--       PRAGMA table_info(gifts) 含 import_batch_id；
--       EXPLAIN QUERY PLAN SELECT id FROM gifts WHERE import_batch_id = ? 应走 idx_gifts_import_batch。

ALTER TABLE gifts ADD COLUMN import_batch_id TEXT;

CREATE TABLE IF NOT EXISTS asr_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  protocol TEXT NOT NULL DEFAULT 'openai-audio',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gifts_import_batch ON gifts (import_batch_id) WHERE import_batch_id IS NOT NULL;

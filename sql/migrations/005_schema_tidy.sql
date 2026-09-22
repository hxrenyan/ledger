-- 整理表结构：合并模型配置，去掉死字段，收据改成一对一。
-- 可重跑。-- @when-column / -- @when-table 包住的语句只在条件还成立时执行；
-- DROP COLUMN 在列已经不存在时由迁移脚本跳过。
--
-- 数据量：users、ai_settings、asr_profiles 是个位数到几十行。
--         attachments 行数等于有收据的流水，单行最大 512KB。
-- 孤儿：没有数据库外键。先把旧配置行拷进 ai_profiles，再删旧表。
-- 丢弃：
--   users.wx_openid / wx_unionid（业务代码从未读写）
--   contacts.note（界面和导入都不写；经 API 存过的备注会丢掉）
--   recurrences.to_account_id（周期记账只支持收支，该列恒为 NULL）
--   attachments.id、attachments.size（id 从不读取；size 等于字节长度）
-- 验证：
--   PRAGMA table_info(users) 不含 wx_openid、wx_unionid，COUNT(*) 与迁移前一致
--   PRAGMA table_info(contacts) 不含 note
--   PRAGMA table_info(recurrences) 不含 to_account_id
--   PRAGMA table_info(attachments) 的 pk 在 transaction_id，不含 id、size，COUNT(*) 不变
--   SELECT kind, COUNT(*) FROM ai_profiles GROUP BY kind 等于原两表行数
--   sqlite_master 不再有 ai_settings、asr_profiles
--   EXPLAIN QUERY PLAN SELECT id FROM ai_profiles WHERE kind = 'llm' ORDER BY sort_order
--     应走 idx_ai_profiles_order

CREATE TABLE IF NOT EXISTS ai_profiles (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  protocol TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS idx_ai_profiles_order ON ai_profiles (kind, sort_order);

-- @when-table ai_settings
INSERT INTO ai_profiles (kind, id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
SELECT 'llm', id, name, enabled, '', base_url, api_key, model, sort_order, updated_at
FROM ai_settings
WHERE NOT EXISTS (
  SELECT 1 FROM ai_profiles p WHERE p.kind = 'llm' AND p.id = ai_settings.id
);

DROP TABLE ai_settings;
-- @end-when

-- @when-table asr_profiles
INSERT INTO ai_profiles (kind, id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
SELECT 'asr', id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at
FROM asr_profiles
WHERE NOT EXISTS (
  SELECT 1 FROM ai_profiles p WHERE p.kind = 'asr' AND p.id = asr_profiles.id
);

DROP TABLE asr_profiles;
-- @end-when

-- @when-column users.wx_openid
DROP TABLE IF EXISTS users_new;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  nickname TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

INSERT INTO users_new (id, username, password_hash, nickname, disabled, created_at)
SELECT id, username, password_hash, nickname, disabled, created_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
-- @end-when

-- 只剩 wx_unionid 时（openid 已单独删掉）再重建一次。两列都在时，上一组已经删干净，这里会跳过。
-- @when-column users.wx_unionid
DROP TABLE IF EXISTS users_new;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  nickname TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

INSERT INTO users_new (id, username, password_hash, nickname, disabled, created_at)
SELECT id, username, password_hash, nickname, disabled, created_at FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
-- @end-when

-- @when-column attachments.id
DROP TABLE IF EXISTS attachments_new;

CREATE TABLE attachments_new (
  transaction_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO attachments_new (transaction_id, ledger_id, mime, bytes, created_at)
SELECT transaction_id, ledger_id, mime, bytes, created_at FROM attachments;

DROP TABLE attachments;

ALTER TABLE attachments_new RENAME TO attachments;
-- @end-when

-- id 已经去掉但 size 还在时再收一次。
-- @when-column attachments.size
DROP TABLE IF EXISTS attachments_new;

CREATE TABLE attachments_new (
  transaction_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO attachments_new (transaction_id, ledger_id, mime, bytes, created_at)
SELECT transaction_id, ledger_id, mime, bytes, created_at FROM attachments;

DROP TABLE attachments;

ALTER TABLE attachments_new RENAME TO attachments;
-- @end-when

ALTER TABLE contacts DROP COLUMN note;

ALTER TABLE recurrences DROP COLUMN to_account_id;

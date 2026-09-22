-- 记账 · 权威全量建表
-- 用途：新库初始化 / 本地 reset。已有数据勿直接 DROP 后重跑。
--
-- 表一览：
--   users          用户（一人一号）
--   ledgers        账本
--   members        账本成员（逻辑关联 ledger_id / user_id）
--   accounts       账户
--   categories     分类
--   transactions   流水（含转账、收据标记）
--   budgets        月预算
--   attachments    收据二进制
--   contacts       人情往来联系人
--   gifts          人情往来记录
--   recurrences    周期记账
--   import_batches 账单导入批次（回溯 / 撤销）
--   ai_settings    AI 解析配置（多套，按 sort_order 失败换下一套）
--   asr_profiles   语音识别配置（多套，按 sort_order 接力）
--
-- 约定：表之间只保留逻辑关联字段，不定义数据库外键；
--       关联完整性由应用层校验，多语句写入走 D1 batch。

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  wx_openid TEXT UNIQUE,
  wx_unionid TEXT,
  nickname TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- ledgers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  invite_code TEXT,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  ledger_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  current_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  to_account_id TEXT,
  category_id TEXT,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  has_receipt INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  import_batch_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  category_id TEXT NOT NULL DEFAULT '',
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (ledger_id, month, category_id)
);

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  ledger_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- contacts / gifts（人情往来）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  name TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occasion TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  import_batch_id TEXT
);

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

-- ---------------------------------------------------------------------------
-- import_batches（账单导入批次；流水通过 transactions.import_batch_id 归属批次）
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- ai_settings（可多套；按 sort_order 从小到大尝试，失败换下一套。仅管理后台可读写）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_settings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- asr_profiles（语音识别，可多套；按 sort_order 从小到大尝试，失败换下一套）
-- protocol 预留接入方式：目前只实现 openai-audio（硅基流动 / OpenAI 兼容 /audio/transcriptions）
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 索引（对应列表/统计查询，不重复主键与 UNIQUE）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tx_ledger_occurred ON transactions (ledger_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_ledger_category ON transactions (ledger_id, category_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_invite ON ledgers (invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_ledger ON contacts (ledger_id, name);
CREATE INDEX IF NOT EXISTS idx_gifts_contact ON gifts (ledger_id, contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_recurrences_next ON recurrences (ledger_id, enabled, next_at);
CREATE INDEX IF NOT EXISTS idx_import_batches_ledger ON import_batches (ledger_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_import_batch ON transactions (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gifts_import_batch ON gifts (import_batch_id) WHERE import_batch_id IS NOT NULL;

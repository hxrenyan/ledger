-- 记账 · 权威全量建表
-- 用途：新库初始化 / 本地 reset。已有数据勿直接 DROP 后重跑。
--
-- 表一览：
--   users            用户（一人一号）
--   user_identities  第三方登录身份（目前只有微信小程序 openid）
--   ledgers          账本
--   members        账本成员（逻辑关联 ledger_id / user_id）
--   accounts       账户
--   categories     分类
--   transactions   流水（含转账、收据标记）
--   budgets        月预算
--   attachments    收据二进制（一笔流水一张，主键即 transaction_id）
--   contacts       人情往来联系人
--   gifts          人情往来记录
--   recurrences    周期记账（只支持收入 / 支出）
--   import_batches 账单导入批次（回溯 / 撤销）
--   ai_profiles    模型配置（kind=llm 解析 / asr 语音 / ocr 图片识别，按 sort_order 接力）
--   app_configs     服务端业务配置（页面归属等，改完 deploy 即生效）
--   handoff_codes   原生 → web-view 网页 的一次性会话交接码
--
-- 约定：表之间只保留逻辑关联字段，不定义数据库外键；
--       关联完整性由应用层校验，多语句写入走 D1 batch。
--       业务主键是 INTEGER PRIMARY KEY AUTOINCREMENT（从 1 起，不复用已删除的号）。
--       外部标识保持 TEXT：openid / unionid、app_configs.key、handoff_codes.code_hash、invite_code。
--       budgets.category_id = 0 表示不限分类的总预算。
--       handoff_codes.ledger_id = 0 表示未指定账本。

-- ---------------------------------------------------------------------------
-- users
-- password_hash 为空：微信登录新建的账号，还没有密码。绑定已有账号后，数据并入对方，这个用户删除。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  nickname TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- user_identities
-- 不把 openid 放回 users：一个用户至多一个微信，后续其他登录方式也走这张表。
-- 查询：登录按 (provider, openid)；绑定和 /me 按 (provider, user_id)。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  openid TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  unionid TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, openid)
);

-- ---------------------------------------------------------------------------
-- ledgers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledgers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  invite_code TEXT,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  ledger_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  to_account_id INTEGER,
  category_id INTEGER,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  has_receipt INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  import_batch_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL DEFAULT 0,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (ledger_id, month, category_id)
);

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  transaction_id INTEGER PRIMARY KEY,
  ledger_id INTEGER NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- contacts / gifts（人情往来）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occasion TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  import_batch_id INTEGER
);

CREATE TABLE IF NOT EXISTS recurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  category_id INTEGER,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  parsed_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  skipped_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  ai_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);

-- ---------------------------------------------------------------------------
-- ai_profiles（解析与语音共用一张配置表）
-- kind：llm = 账单解析；asr = 语音识别；ocr = 图片识别。同一 kind 内按 sort_order 失败换下一套。
-- protocol：asr 目前只实现 openai-audio；ocr 目前只有 openai-vision；llm 留空（走 chat/completions）。
-- id 全局自增。SQLite 的 AUTOINCREMENT 不能挂在复合主键上，所以不再用 (kind, id)。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  protocol TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- app_configs（服务端业务配置，key 级覆盖）
-- 用途：页面归属（原生 / web-view）、开关与文案。改完 deploy 即生效，不用发版。
-- 只放数据，不放可执行代码——微信禁止动态下发代码。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_configs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- handoff_codes（小程序原生 → web-view 网页 的一次性会话交接码）
-- web-view 里没有 wx.login，网页侧靠这个补会话。
-- 只存 SHA-256；5 分钟过期；用一次即失效（UPDATE ... RETURNING 原子抢占）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handoff_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ledger_id INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 索引（对应列表/统计查询，不重复主键与 UNIQUE）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tx_ledger_occurred ON transactions (ledger_id, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_members_user ON members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_invite ON ledgers (invite_code) WHERE invite_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_ledger ON contacts (ledger_id, archived, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_gifts_contact ON gifts (contact_id, ledger_id, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_gifts_ledger_occurred ON gifts (ledger_id, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS idx_recurrences_next ON recurrences (ledger_id, enabled, next_at);
CREATE INDEX IF NOT EXISTS idx_import_batches_ledger ON import_batches (ledger_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_import_batch ON transactions (ledger_id, import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gifts_import_batch ON gifts (ledger_id, import_batch_id, contact_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_profiles_order ON ai_profiles (kind, sort_order, updated_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (provider, user_id);
-- 交接码只在签发时按过期时间清理一次，索引服务这个 DELETE。
CREATE INDEX IF NOT EXISTS idx_handoff_expires ON handoff_codes (expires_at);

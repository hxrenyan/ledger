-- @when-column-type users.id TEXT
-- @execute-whole-file
-- 把业务主键从 TEXT（UUID）改成 INTEGER PRIMARY KEY AUTOINCREMENT，并重写逻辑关联。
-- 不改：openid / unionid、app_configs.key、handoff_codes.code_hash、invite_code。
-- users.id 已是 INTEGER 时，迁移脚本整文件跳过。
--
-- 先让应用把缺列补齐（当前 schema 的列都要在），再跑本文件。
-- 跑完已签发的 JWT 全部失效，用户需要重新登录。
--
-- 执行前核对（孤儿应为 0，行数记下来和执行后比）：
--   SELECT COUNT(*) AS users FROM users;
--   SELECT COUNT(*) AS ledgers FROM ledgers;
--   SELECT COUNT(*) AS transactions FROM transactions;
--   SELECT COUNT(*) AS orphan_ledgers
--     FROM ledgers l LEFT JOIN users u ON u.id = l.owner_id WHERE u.id IS NULL;
--   SELECT COUNT(*) AS orphan_tx_account
--     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL;
--   SELECT COUNT(*) AS orphan_members
--     FROM members m
--     LEFT JOIN ledgers l ON l.id = m.ledger_id
--     LEFT JOIN users u ON u.id = m.user_id
--     WHERE l.id IS NULL OR u.id IS NULL;
--
-- 执行后核对：
--   SELECT type FROM pragma_table_info('users') WHERE name = 'id';          -- INTEGER
--   SELECT COUNT(*) AS users FROM users;                                    -- 与执行前一致
--   SELECT COUNT(*) AS ledgers FROM ledgers;
--   SELECT COUNT(*) AS transactions FROM transactions;
--   SELECT COUNT(*) AS orphan_tx_account
--     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL;  -- 0
--   SELECT COUNT(*) AS orphan_members
--     FROM members m
--     LEFT JOIN users u ON u.id = m.user_id
--     LEFT JOIN ledgers l ON l.id = m.ledger_id
--     WHERE u.id IS NULL OR l.id IS NULL;                                   -- 0

CREATE TABLE users_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  nickname TEXT NOT NULL DEFAULT '',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO users_v2 (username, password_hash, nickname, disabled, created_at, old_id)
SELECT username, password_hash, nickname, disabled, created_at, id FROM users;

CREATE TABLE ledgers_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  invite_code TEXT,
  created_at INTEGER NOT NULL,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO ledgers_v2 (name, owner_id, invite_code, created_at, old_id)
SELECT l.name, u.id, l.invite_code, l.created_at, l.id
FROM ledgers l JOIN users_v2 u ON u.old_id = l.owner_id;

CREATE TABLE members_v2 (
  ledger_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);
INSERT INTO members_v2 (ledger_id, user_id, role, created_at)
SELECT l.id, u.id, m.role, m.created_at
FROM members m
JOIN ledgers_v2 l ON l.old_id = m.ledger_id
JOIN users_v2 u ON u.old_id = m.user_id;

CREATE TABLE accounts_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  current_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO accounts_v2 (ledger_id, name, type, sort_order, archived, current_cents, created_at, old_id)
SELECT l.id, a.name, a.type, a.sort_order, a.archived, a.current_cents, a.created_at, a.id
FROM accounts a JOIN ledgers_v2 l ON l.old_id = a.ledger_id;

CREATE TABLE categories_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO categories_v2 (ledger_id, name, kind, sort_order, archived, created_at, old_id)
SELECT l.id, c.name, c.kind, c.sort_order, c.archived, c.created_at, c.id
FROM categories c JOIN ledgers_v2 l ON l.old_id = c.ledger_id;

CREATE TABLE contacts_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO contacts_v2 (ledger_id, name, relation, archived, created_at, old_id)
SELECT l.id, c.name, c.relation, c.archived, c.created_at, c.id
FROM contacts c JOIN ledgers_v2 l ON l.old_id = c.ledger_id;

CREATE TABLE import_batches_v2 (
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
  undone_at INTEGER,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO import_batches_v2 (
  ledger_id, source, filename, parsed_rows, imported_rows, skipped_rows, duplicate_rows,
  ai_used, status, created_by, created_at, undone_at, old_id
)
SELECT l.id, b.source, b.filename, b.parsed_rows, b.imported_rows, b.skipped_rows, b.duplicate_rows,
       b.ai_used, b.status, u.id, b.created_at, b.undone_at, b.id
FROM import_batches b
JOIN ledgers_v2 l ON l.old_id = b.ledger_id
JOIN users_v2 u ON u.old_id = b.created_by;

CREATE TABLE transactions_v2 (
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
  updated_at INTEGER NOT NULL,
  old_id TEXT NOT NULL UNIQUE
);
INSERT INTO transactions_v2 (
  ledger_id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note,
  has_receipt, excluded, import_batch_id, created_by, created_at, updated_at, old_id
)
SELECT
  l.id,
  (SELECT a.id FROM accounts_v2 a WHERE a.old_id = t.account_id),
  (SELECT a.id FROM accounts_v2 a WHERE a.old_id = t.to_account_id),
  CASE WHEN t.category_id IS NULL OR t.category_id = '' THEN NULL
       ELSE (SELECT c.id FROM categories_v2 c WHERE c.old_id = t.category_id) END,
  t.kind, t.amount_cents, t.occurred_at, t.note, t.has_receipt, t.excluded,
  CASE WHEN t.import_batch_id IS NULL OR t.import_batch_id = '' THEN NULL
       ELSE (SELECT b.id FROM import_batches_v2 b WHERE b.old_id = t.import_batch_id) END,
  (SELECT u.id FROM users_v2 u WHERE u.old_id = t.created_by),
  t.created_at, t.updated_at, t.id
FROM transactions t
JOIN ledgers_v2 l ON l.old_id = t.ledger_id;

CREATE TABLE budgets_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL DEFAULT 0,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (ledger_id, month, category_id)
);
INSERT INTO budgets_v2 (ledger_id, category_id, month, amount_cents, created_at)
SELECT
  l.id,
  CASE WHEN b.category_id IS NULL OR b.category_id = '' THEN 0
       ELSE (SELECT c.id FROM categories_v2 c WHERE c.old_id = b.category_id) END,
  b.month, b.amount_cents, b.created_at
FROM budgets b
JOIN ledgers_v2 l ON l.old_id = b.ledger_id;

CREATE TABLE attachments_v2 (
  transaction_id INTEGER PRIMARY KEY,
  ledger_id INTEGER NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO attachments_v2 (transaction_id, ledger_id, mime, bytes, created_at)
SELECT tx.id, l.id, a.mime, a.bytes, a.created_at
FROM attachments a
JOIN transactions_v2 tx ON tx.old_id = a.transaction_id
JOIN ledgers_v2 l ON l.old_id = a.ledger_id;

CREATE TABLE gifts_v2 (
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
INSERT INTO gifts_v2 (
  ledger_id, contact_id, kind, amount_cents, occasion, occurred_at, note,
  created_by, created_at, updated_at, import_batch_id
)
SELECT
  l.id,
  (SELECT c.id FROM contacts_v2 c WHERE c.old_id = g.contact_id),
  g.kind, g.amount_cents, g.occasion, g.occurred_at, g.note,
  (SELECT u.id FROM users_v2 u WHERE u.old_id = g.created_by),
  g.created_at, g.updated_at,
  CASE WHEN g.import_batch_id IS NULL OR g.import_batch_id = '' THEN NULL
       ELSE (SELECT b.id FROM import_batches_v2 b WHERE b.old_id = g.import_batch_id) END
FROM gifts g
JOIN ledgers_v2 l ON l.old_id = g.ledger_id;

CREATE TABLE recurrences_v2 (
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
INSERT INTO recurrences_v2 (
  ledger_id, kind, amount_cents, account_id, category_id, note, day_of_month, next_at, enabled, created_at
)
SELECT
  l.id, r.kind, r.amount_cents,
  (SELECT a.id FROM accounts_v2 a WHERE a.old_id = r.account_id),
  CASE WHEN r.category_id IS NULL OR r.category_id = '' THEN NULL
       ELSE (SELECT c.id FROM categories_v2 c WHERE c.old_id = r.category_id) END,
  r.note, r.day_of_month, r.next_at, r.enabled, r.created_at
FROM recurrences r
JOIN ledgers_v2 l ON l.old_id = r.ledger_id;

CREATE TABLE user_identities_v2 (
  provider TEXT NOT NULL,
  openid TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  unionid TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, openid)
);
INSERT INTO user_identities_v2 (provider, openid, user_id, unionid, created_at)
SELECT i.provider, i.openid, u.id, i.unionid, i.created_at
FROM user_identities i JOIN users_v2 u ON u.old_id = i.user_id;

CREATE TABLE handoff_codes_v2 (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ledger_id INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO handoff_codes_v2 (code_hash, user_id, ledger_id, expires_at, used_at, created_at)
SELECT
  h.code_hash,
  u.id,
  CASE WHEN h.ledger_id IS NULL OR h.ledger_id = '' THEN 0
       ELSE COALESCE((SELECT l.id FROM ledgers_v2 l WHERE l.old_id = h.ledger_id), 0) END,
  h.expires_at, h.used_at, h.created_at
FROM handoff_codes h
JOIN users_v2 u ON u.old_id = h.user_id;

CREATE TABLE ai_profiles_v2 (
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
INSERT INTO ai_profiles_v2 (kind, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
SELECT kind, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at
FROM ai_profiles
ORDER BY kind, sort_order, id;

DROP TABLE users;
DROP TABLE ledgers;
DROP TABLE members;
DROP TABLE accounts;
DROP TABLE categories;
DROP TABLE contacts;
DROP TABLE import_batches;
DROP TABLE transactions;
DROP TABLE budgets;
DROP TABLE attachments;
DROP TABLE gifts;
DROP TABLE recurrences;
DROP TABLE user_identities;
DROP TABLE handoff_codes;
DROP TABLE ai_profiles;

ALTER TABLE users_v2 RENAME TO users;
ALTER TABLE ledgers_v2 RENAME TO ledgers;
ALTER TABLE members_v2 RENAME TO members;
ALTER TABLE accounts_v2 RENAME TO accounts;
ALTER TABLE categories_v2 RENAME TO categories;
ALTER TABLE contacts_v2 RENAME TO contacts;
ALTER TABLE import_batches_v2 RENAME TO import_batches;
ALTER TABLE transactions_v2 RENAME TO transactions;
ALTER TABLE budgets_v2 RENAME TO budgets;
ALTER TABLE attachments_v2 RENAME TO attachments;
ALTER TABLE gifts_v2 RENAME TO gifts;
ALTER TABLE recurrences_v2 RENAME TO recurrences;
ALTER TABLE user_identities_v2 RENAME TO user_identities;
ALTER TABLE handoff_codes_v2 RENAME TO handoff_codes;
ALTER TABLE ai_profiles_v2 RENAME TO ai_profiles;

ALTER TABLE users DROP COLUMN old_id;
ALTER TABLE ledgers DROP COLUMN old_id;
ALTER TABLE accounts DROP COLUMN old_id;
ALTER TABLE categories DROP COLUMN old_id;
ALTER TABLE contacts DROP COLUMN old_id;
ALTER TABLE import_batches DROP COLUMN old_id;
ALTER TABLE transactions DROP COLUMN old_id;

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
CREATE INDEX IF NOT EXISTS idx_ai_profiles_order ON ai_profiles (kind, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (provider, user_id);
CREATE INDEX IF NOT EXISTS idx_handoff_expires ON handoff_codes (expires_at);

-- 微信小程序登录身份。openid 不放回 users（005 刚删掉从未使用的 wx_openid）。
-- 可重跑。
--
-- 数据量：新表，0 行。不回填历史 openid。
-- 孤儿：无。写入时由应用校验 user_id 对应用户存在。
-- 验证：
--   PRAGMA table_info(user_identities) 含 provider, openid, user_id, unionid, created_at
--   EXPLAIN QUERY PLAN SELECT user_id FROM user_identities WHERE provider = 'wechat' AND openid = 'x'
--     应走 user_identities 的主键
--   EXPLAIN QUERY PLAN SELECT openid FROM user_identities WHERE provider = 'wechat' AND user_id = 'u'
--     应走 idx_user_identities_user

CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  openid TEXT NOT NULL,
  user_id TEXT NOT NULL,
  unionid TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, openid)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (provider, user_id);

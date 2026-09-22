-- AI 配置从单行改为多套接力。已有 id='default' 的那一行保留，sort_order 默认为 0，仍排在最前。
-- 数据量：线上最多 1 行。验证：PRAGMA table_info(ai_settings) 含 name、sort_order。

ALTER TABLE ai_settings ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_settings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

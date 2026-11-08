-- 双向转分：旧记录保留空来源字段，新记录记录转出方快照。
ALTER TABLE score_entries ADD COLUMN from_player_id TEXT;
ALTER TABLE score_entries ADD COLUMN from_player_name TEXT;
ALTER TABLE score_entries ADD COLUMN from_score_after INTEGER;

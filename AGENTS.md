# 项目协作约定

## 数据库规范

- 禁止在建表或迁移脚本中定义数据库外键，包括 `FOREIGN KEY`、`REFERENCES` 和级联删除规则。
- 表之间可以保留 `*_id` 逻辑关联字段；写入前校验关联对象，删除父记录时由应用层显式更新或删除关联数据。
- 多表关联写入、关联清理必须使用 D1 `batch`，保证同一批操作原子执行；禁止依赖数据库隐式级联。
- 新增索引前必须对应实际查询条件或排序；不得为 `INTEGER PRIMARY KEY`、`UNIQUE` 已生成的索引重复建索引。
- 复合索引按最左前缀复用。删除索引前必须通过源码查询盘点和 `EXPLAIN QUERY PLAN` 验证。
- 数据库结构变更同时维护 `sql/schema.sql` 和 `sql/migrations/`；迁移需提供数据量、孤儿数据及关键查询验证方式。

## 启动与库

- 本地开发：`npm run db:local`（首次或 reset）后 `npm run dev`（`wrangler dev --env local`）。
- 不要在 Worker 请求路径里偷偷跑全量建表；建表走 `sql/schema.sql` 与 `scripts/d1-migrate.mjs`。
- 表结构以 `sql/schema.sql` 为唯一权威，禁止再维护第二份建表 SQL。

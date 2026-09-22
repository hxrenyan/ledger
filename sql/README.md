# SQL 目录说明

| 路径 | 用途 |
|------|------|
| `schema.sql` | **唯一权威**全量建表（新库 / 本地 reset） |
| `migrations/` | 增量迁移（已有库用 `db:migrate-all-*`） |

## 数据库约定

- 项目不使用数据库外键，只保留 `*_id` 等逻辑关联字段。
- 关联校验、级联删除和置空由应用层显式处理，多语句写入使用 D1 `batch`。
- 索引必须服务于现有查询或排序；禁止重复索引主键、唯一约束，优先复用复合索引最左前缀。
- 含表重建、触发器等不可拆分语句的迁移，在文件首行添加 `-- @execute-whole-file`，迁移脚本会整文件事务执行。

## 常用命令

```bash
# 新库初始化
npm run db:local          # 或 db:remote

# 本地清空并重建（丢数据）
npm run db:reset-local

# 已有库跑增量
npm run db:migrate-all-local
npm run db:migrate-all-remote
```

## 表结构（摘要）

| 表 | PK | 说明 |
|----|-----|------|
| `users` | TEXT | 用户；`disabled` 停用 |
| `ledgers` | TEXT | 账本；`invite_code` 邀请 |
| `members` | `(ledger_id, user_id)` | 账本成员 |
| `accounts` | TEXT | 账户 |
| `categories` | TEXT | 收支分类 |
| `transactions` | TEXT | 流水；金额整数分；`import_batch_id` 归属导入批次（手工录入为空） |
| `budgets` | TEXT | 月预算 |
| `attachments` | TEXT | 收据图 |
| `contacts` | TEXT | 人情联系人 |
| `gifts` | TEXT | 人情往来 |
| `recurrences` | TEXT | 周期记账 |
| `import_batches` | TEXT | 账单导入批次台账（回溯 / 撤销） |
| `ai_settings` | TEXT | AI 解析配置，全局单行（`id='default'`） |
| `asr_profiles` | TEXT | 语音识别配置，多套按 `sort_order` 接力；不保存录音 |

新环境只用 `schema.sql`。线上已有数据只追加 `sql/migrations/`，不要对生产库重跑全量 schema。

导入与 AI 配置的字段语义见 [docs/import.md](../docs/import.md)。

# SQL 目录说明

| 路径 | 用途 |
|------|------|
| `schema.sql` | **唯一权威**全量建表（新库 / 本地 reset） |
| `migrations/` | 增量迁移（已有库用 `db:migrate-all-*`） |

## 数据库约定

- 项目不使用数据库外键，只保留 `*_id` 等逻辑关联字段。
- 关联校验、级联删除和置空由应用层显式处理，多语句写入使用 D1 `batch`。
- 索引必须服务于现有查询或排序；禁止重复索引主键、唯一约束，优先复用复合索引最左前缀。
- 含表重建、触发器等不可拆分语句的迁移，在文件首行添加 `-- @execute-whole-file`，迁移脚本会整文件执行。
- `-- @when-column 表.列` / `-- @when-table 表` 到 `-- @end-when`：条件还成立才执行这一组，方便迁移重跑。
- `ALTER TABLE ... DROP COLUMN` 在列已经不存在时跳过。

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
| `users` | 自增整数 | 用户；`disabled` 停用；`password_hash` 为空表示只有微信登录 |
| `user_identities` | `(provider, openid)` | 第三方身份。目前 `provider=wechat`；`user_id` 是用户自增主键。一个用户至多一条，见 `idx_user_identities_user` |
| `ledgers` | 自增整数 | 账本；`invite_code` 邀请 |
| `members` | `(ledger_id, user_id)` | 账本成员。两个字段都是自增主键 |
| `accounts` | 自增整数 | 账户 |
| `categories` | 自增整数 | 收支分类 |
| `transactions` | 自增整数 | 流水；金额整数分；`import_batch_id` 归属导入批次（手工录入为空） |
| `budgets` | 自增整数 | 月预算。`category_id = 0` 表示不限分类的总预算 |
| `attachments` | `transaction_id` | 收据图，一笔流水一张。主键即流水自增 id |
| `contacts` | 自增整数 | 人情联系人 |
| `gifts` | 自增整数 | 人情往来 |
| `recurrences` | 自增整数 | 周期记账（只支持收入 / 支出） |
| `import_batches` | 自增整数 | 账单导入批次台账（回溯 / 撤销） |
| `ai_profiles` | 自增整数 | 模型配置。`llm` 解析账单，`asr` 语音识别，`ocr` 图片识别；同 kind 内按 `sort_order` 接力。不保存录音和账单原文 |
| `app_configs` | `key` | 服务端业务配置。目前存 `webview.enabled` / `webview.host` / `webview.pages`（页面归属表，原生 or web-view）。改完 `deploy` 即生效，不用发版 |
| `handoff_codes` | `code_hash` | 一次性会话交接码。web-view 里没有 `wx.login`，网页侧靠它换回会话；只存 SHA-256，5 分钟过期，用一次即失效 |

新环境只用 `schema.sql`。线上已有数据只追加 `sql/migrations/`，不要对生产库重跑全量 schema。

导入与 AI 配置的字段语义见 [docs/import.md](../docs/import.md)。

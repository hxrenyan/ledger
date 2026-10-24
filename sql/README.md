# SQL 目录说明

| 路径 | 用途 |
|------|------|
| `schema.sql` | **唯一权威**全量建表（新库 / 本地 reset） |
| `migrations/` | 增量迁移（已有库用 `npm run db:migrate`） |

## 数据库约定

- 项目不使用数据库外键，只保留 `*_id` 等逻辑关联字段。
- 关联校验、级联删除和置空由应用层显式处理，多语句写入使用 `db.batch`（SQLite 事务）。
- 索引必须服务于现有查询或排序；禁止重复索引主键、唯一约束，优先复用复合索引最左前缀。
- 含表重建、触发器等不可拆分语句的迁移，在文件首行添加 `-- @execute-whole-file`，迁移脚本会整文件执行。
- `-- @when-column 表.列` / `-- @when-table 表` 到 `-- @end-when`：条件还成立才执行这一组，方便迁移重跑。
- `ALTER TABLE ... DROP COLUMN` 在列已经不存在时跳过。

## 常用命令

```bash
# 新库初始化
npm run db:local

# 本地清空并重建（丢数据）
npm run db:reset-local

# 已有库跑增量（库文件由 DB_PATH 指定，默认 ./data/ledger.db）
npm run db:migrate
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
| `dict_items` | 自增整数 | 可复用配置。账本、账号字段都空是公共项；仅 `ledger_id` 有值归账本，仅 `user_id` 有值归账号。按范围唯一，见对应索引 |
| `contacts` | 自增整数 | 人情联系人，`user_id` 是账本主人账号；日子不写在这张表上 |
| `contact_dates` | 自增整数 | 联系人的日子，按主人账号和人列出，见 `idx_contact_dates_user` |
| `gifts` | 自增整数 | 人情往来 |
| `recurrences` | 自增整数 | 周期记账（只支持收入 / 支出） |
| `import_batches` | 自增整数 | 账单导入批次台账（回溯 / 撤销） |
| `ai_profiles` | 自增整数 | 模型配置。`llm` 解析账单，`asr` 语音识别，`ocr` 图片识别；同 kind 内按 `sort_order` 接力。不保存录音和账单原文 |
| `app_configs` | `key` | 服务端业务配置。`tools.mode` 为 `native` 或 `h5`（缺省原生），`miniprogram.client` 是关于文案和最低版本，另有微信登录凭证等。改完即生效，不用发版 |
| `handoff_codes` | `code_hash` | 一次性会话交接码。web-view 里没有 `wx.login`，网页侧靠它换回会话；只存 SHA-256，5 分钟过期，用一次即失效 |
| `point_accounts` | `user_id` | 微信用户积分余额。一人一行，没有微信身份的账号不写入 |
| `point_entries` | 自增整数 | 积分明细，只追加。`biz_key` 避免同一天或同一次识别重复入账，见 `idx_point_entries_biz` |
| `point_checkins` | `user_id` | 连续进入。`last_day` 是上海日期，断一天从 1 重新计 |
| `point_calls` | 自增整数 | 每种识别每天的调用次数，含失败。按 `user_id, kind, day` 计数，见 `idx_point_calls_user_day` |
| `feedbacks` | 自增整数 | 用户反馈。自己的列表走 `idx_feedbacks_user`，后台按状态走 `idx_feedbacks_status`，全部按时间走 `idx_feedbacks_recent` |
| `day_notes` | 自增整数 | 个人日历记事。跟用户走，不跟账本。按 `user_id, day` 查某月或某一天，见 `idx_day_notes_user_day` |

新环境只用 `schema.sql`。线上已有数据只追加 `sql/migrations/`，不要对生产库重跑全量 schema。

## 联系人归属迁移

`2026-10-21-contact-owner.sql` 把旧联系人及日子按原账本的 `owner_id` 归入主人账号，并把联系人日子标签从账本范围转为账号范围。联系人 ID、日子和礼金记录保留；同一主人多个旧账本的同名日子标签合并。礼金仍保留原账本，不迁到主人私有范围。

启动时不会自动执行这次归属转换，旧库继续按账本使用联系人及标签，新库按账号范围建表。暂缓切换时不要运行 `npm run db:migrate`；确认切换后先停旧后端并备份，再显式执行该命令，最后启动新后端。旧后端不能读写迁移后的联系人字段，不能与新后端共用迁移后的数据库。

执行前先备份数据库文件。迁移后检查主人映射、日期关联和金额仍挂在原账本：

```sql
SELECT c.id, c.user_id, l.owner_id FROM contacts c
LEFT JOIN ledgers l ON l.owner_id = c.user_id WHERE l.id IS NULL;
SELECT d.id FROM contact_dates d
LEFT JOIN contacts c ON c.id = d.contact_id WHERE c.id IS NULL OR c.user_id != d.user_id;
SELECT g.ledger_id, g.contact_id, g.amount_cents FROM gifts g
LEFT JOIN contacts c ON c.id = g.contact_id WHERE c.id IS NULL;
EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE user_id = 1 ORDER BY archived, name COLLATE NOCASE;
```

前两项应无记录；第三项用于核对联系人可解析，礼金金额仍由 `gifts.ledger_id` 隔离；计划应使用 `idx_contacts_user`。如果校验失败，停止应用新版本并从迁移前备份恢复，再修复异常数据后重试。`npm run db:migrate` 可重复执行，不要在正式数据上手工反向改列。

导入与 AI 配置的字段语义见 [docs/import.md](../docs/import.md)。

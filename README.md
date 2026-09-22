# 记账

基于 **Cloudflare Workers + D1** 的个人/家庭记账。一人一号；微信小程序放到迁 Sealos 后再做。

## 功能概览

- **账号登录**（用户名密码 + Bearer JWT）
- **多账本 / 家庭成员**（邀请码）
- 账户、分类、收支、转账
- 月预算、收据图
- **人情往来**（按人记送出/收入、事由、差额）
- **账单导入**：微信 / 支付宝 / 银行 / 通用 CSV、Excel、JSON，可选 AI 兜底解析（见 [docs/import.md](docs/import.md)）
- CSV 导出
- **管理后台** `/admin`：用户/账本概览、停用账号、AI 配置

管理员口令与用户账本分离（`ADMIN_TOKEN`）。

---

## 架构

```text
浏览器
  → H5（public/，Vue 构建）
  → Cloudflare Worker（Hono）
       → JWT（用户 / 管理员）
       → 账本与流水（D1）
```

| 组件 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 框架 | Hono |
| 数据库 | Cloudflare D1 |
| 认证 | 用户名密码 + JWT（PBKDF2） |
| 前端 | `web/` → 构建到 `public/` |
| 金额 | 整数分 |
| 时区 | 月份按 `Asia/Shanghai` |

---

## 目录结构

```text
ledger/
├── public/                 # Vue 构建产物（wrangler assets）
├── web/                    # H5 源码
├── src/
│   ├── index.ts            # Worker 入口
│   ├── app.ts
│   ├── auth/
│   ├── imports/            # 账单导入：解析、建议、AI、编排
│   ├── db/
│   └── routes/
├── sql/
│   ├── schema.sql          # 权威全量建表
│   └── migrations/         # 增量迁移
├── scripts/d1-migrate.mjs
├── wrangler.toml
├── .dev.vars.example
├── AGENTS.md
└── docs/
```

模块说明见 `src/README.md`；SQL 说明见 `sql/README.md`；账单导入见 `docs/import.md`。

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `JWT_SECRET` | 是 | 签 JWT |
| `ADMIN_TOKEN` | 管理后台需要 | 管理员口令，登录后换管理员 JWT |

本地：

```bash
cp .dev.vars.example .dev.vars
# 填 JWT_SECRET / ADMIN_TOKEN
```

线上：

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_TOKEN
```

表结构以 `sql/schema.sql` 为准。

---

## 本地运行

```bash
cd /Users/huangxin/data/ai/other/ledger
npm install

cp .dev.vars.example .dev.vars

# 首次或表结构变了：
npm run db:reset-local
# 或只建表不清空：
# npm run db:local

npm run dev
```

打开终端提示的地址（如 `http://127.0.0.1:8787`）：

1. 注册用户名（3–32 位字母数字下划线）和至少 8 位密码
2. 管理后台：`/admin`，口令为 `ADMIN_TOKEN`

### 常用脚本

| 命令 | 作用 |
|------|------|
| `npm run dev` | 构建 H5 并 `wrangler dev --env local` |
| `npm run db:local` | 初始化本地表（不清空） |
| `npm run db:reset-local` | **清空并重建**本地 D1 |
| `npm run db:migrate-all-local` | 按序执行 `sql/migrations/*`（本地） |
| `npm run db:migrate-all-remote` | 按序执行 `sql/migrations/*`（远程） |
| `npm run db:create` | 创建远程 D1 |
| `npm run db:remote` | 初始化远程表 |
| `npm run typecheck` | TypeScript 检查 |
| `npm test` | 单测 |

H5 热更新可另开：`npm run dev:web`（代理 `/api` 到 8787）。

---

## Cloudflare 部署

1. `npx wrangler login`
2. `npm run db:create`，把 `database_id` 写入 `wrangler.toml` 顶层与 `[env.local]`
3. `npm run db:remote`
4. `npx wrangler secret put JWT_SECRET` 与 `ADMIN_TOKEN`
5. `npm run deploy`

### 自定义域名

域名所在 zone 需在同一 Cloudflare 账号下。在 `wrangler.toml` 顶层加自定义域：

```toml
routes = [
  { pattern = "ledger.example.com", custom_domain = true }
]
```

再 `npm run deploy`：wrangler 会建好 DNS 记录并签发证书，输出里会出现 `xxx (custom domain)` 一行。

> 注意：`wrangler.toml` 的顶层键（`routes`、`workers_dev`、`preview_urls`）必须写在第一个表头（如 `[assets]`）**之前**，
> 否则会被归入前一个表，wrangler 只给 `Unexpected fields found in assets field` 警告且静默忽略路由。

`workers_dev = true` 保留 `*.workers.dev` 备用入口；`preview_urls = false` 防止每个版本生成公开预览地址。

---

## 迁 Sealos（后续）

默认启动是 Workers + D1。迁应用管理时可用 `npm run start:node`（SQLite 文件 + PVC），`Dockerfile` 仍可用于该路径。不要多副本。

---

## 接口约定

用户：`Authorization: Bearer <jwt>` + `X-Ledger-Id`  
管理员：`POST /api/v1/admin/login`  
健康检查：`GET /api/health`  
金额：整数分  
时间：UTC 毫秒，月份 `Asia/Shanghai`

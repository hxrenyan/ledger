# 记账

基于 **Node + SQLite** 的个人/家庭记账，部署在 Sealos（https://bja.sealos.run）。网页用户名密码和小程序微信登录各自是一个账号；微信登录后可以绑定已有密码账号，绑定后合成一个，两种方式都能登，数据并在一起。

## 功能概览

- **账号登录**（用户名密码 + Bearer JWT）
- **微信小程序登录**（`wx.login` 的 code 换 openid；可再绑定已有账号）
- **多账本 / 家庭成员**（邀请码）
- 账户、分类、收支、转账
- 月预算、收据图
- **人情往来**（按人记送出/收入、事由、差额）
- **账单导入**：微信 / 支付宝 / 银行 / 通用 CSV、Excel、JSON，可选 AI 兜底解析（见 [docs/import.md](docs/import.md)）
- **拍照记账**：拍小票 / 发票 / 支付截图 / 手写本，OCR 认字再由模型整理成流水，逐行核对后入库（见 [docs/photo.md](docs/photo.md)）
- CSV 导出
- **管理后台** `/admin`：用户/账本概览、停用账号、AI 配置、图片识别配置

管理员口令与用户账本分离（`ADMIN_TOKEN`）。

---

## 架构

```text
浏览器
  → H5（public/，Vue 构建，由同一进程托管）
  → Node（Hono）
       → JWT（用户 / 管理员）
       → 账本与流水（SQLite 文件）
```

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js（Sealos 单副本容器） |
| 框架 | Hono |
| 数据库 | SQLite（`DB_PATH`，线上挂在 `/data`） |
| 认证 | 用户名密码 + JWT（PBKDF2） |
| 前端 | `web/` → 构建到 `public/` |
| 金额 | 整数分 |
| 时区 | 月份按 `Asia/Shanghai` |

---

## 目录结构

```text
ledger/
├── public/                 # Vue 构建产物
├── web/                    # H5 源码
├── src/
│   ├── node.ts             # 进程入口
│   ├── app.ts
│   ├── auth/
│   ├── imports/            # 账单导入：解析、建议、AI、编排
│   ├── db/
│   └── routes/
├── sql/
│   ├── schema.sql          # 权威全量建表
│   └── migrations/         # 增量迁移
├── miniprogram/            # 原生小程序（构建与 web-view 接入见 miniprogram/README.md）
├── scripts/migrate.mjs
├── Dockerfile              # Sealos 应用管理用这个构建
├── .env.example
├── AGENTS.md
└── docs/
```

模块说明见 `src/README.md`；SQL 说明见 `sql/README.md`；账单导入见 `docs/import.md`；拍照记账见 `docs/photo.md`；小程序与 web-view 混合架构见 `docs/webview-hybrid.md`。

---

## 小程序与 web-view 混合

`miniprogram/` 是原生小程序，复用上面这套 API。高频操作（登录、明细、记账、转账、收据、语音、人情）走原生；长尾页（预算、分类、周期记账、账单导入、账本与成员）可以切到 `<web-view>` 加载同一份 H5 代码，**改这些页面不走审核**。

「哪个页走原生、哪个页走网页」由服务端 `app_configs` 表决定（`PUT /api/v1/admin/app-config`），改完即生效，不用发版：

```bash
GET /api/v1/app/config          # 小程序启动时拉取，缓存在 storage
PUT /api/v1/admin/app-config    # 运维灰度切换，可单页回退
```

默认全部原生；`webview.enabled=0` 就是纯原生，此时连业务域名都不需要。

> ⚠️ `<web-view>` 的业务域名**仅非个人主体小程序可配置**，域名还需 HTTPS + ICP 备案（备案主体与小程序认证主体一致）。三个条件缺一不可。

`web-view` 里没有 `wx.login`，网页会话靠一次性交接码换：原生 `POST /api/v1/webview/handoff` → 网页 `POST /api/v1/auth/webview-session`（5 分钟过期、用一次即失效、库里只存 SHA-256）。

细节见 [miniprogram/README.md](miniprogram/README.md#web-view-混合架构) 与 [docs/webview-hybrid.md](docs/webview-hybrid.md)。

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `JWT_SECRET` | 是 | 签 JWT |
| `ADMIN_TOKEN` | 管理后台需要 | 管理员口令，登录后换管理员 JWT |
| `WX_APPID` | 小程序登录需要 | 小程序 AppId |
| `WX_SECRET` | 小程序登录需要 | 小程序 AppSecret，只放服务端 |
| `MP_VERIFY` | 用到 web-view 时需要 | 微信业务域名校验文件的内容（`MP_verify_<串>.txt` 里的纯文本）。不配也可以，改成把 txt 放进 `public/` |

本地：

```bash
cp .env.example .env
# 填 JWT_SECRET / ADMIN_TOKEN
```

线上：在 Sealos 应用的环境变量里填写，不要写进镜像。

表结构以 `sql/schema.sql` 为准。

---

## 本地运行

```bash
cd /Users/huangxin/data/ai/other/ledger
npm install

cp .env.example .env

# 首次或表结构变了：
npm run db:reset-local
# 或只建表不清空：
# npm run db:local

npm run dev
```

打开 `http://127.0.0.1:3000`：

1. 注册用户名（3–32 位字母数字下划线）和至少 8 位密码
2. 管理后台：`/admin`，口令为 `ADMIN_TOKEN`

### 常用脚本

| 命令 | 作用 |
|------|------|
| `npm run dev` | 构建 H5 并启动 Node（`http://127.0.0.1:3000`） |
| `npm run start` | 只启动进程（`public/` 需已经构建过） |
| `npm run db:local` | 初始化本地 SQLite（不清空） |
| `npm run db:reset-local` | **清空并重建**本地库 |
| `npm run db:migrate` | 按序执行 `sql/migrations/*` |
| `npm run typecheck` | TypeScript 检查 |
| `npm run typecheck:web` | H5 类型检查（`vue-tsc`） |
| `npm test` | 单测 |
| `npm run check:miniprogram` | 小程序静态检查（语法、JSON、页面/组件路径、跨端契约） |

H5 热更新可另开：`npm run dev:web`（代理 `/api` 到 3000）。

---

## 部署到 Sealos

控制台：[https://bja.sealos.run](https://bja.sealos.run)。应用管理里用仓库根目录的 `Dockerfile` 构建。

1. 容器端口填 `3000`，打开外网访问。Sealos 会分配一个 `https://<随机串>.bja.sealos.run`，这才是应用地址；`https://bja.sealos.run` 本身是控制台。
2. 挂一块持久卷到 `/data`。库文件是 `/data/ledger.db`。**实例数保持 1**，SQLite 不能多副本同时写。
3. 环境变量：`JWT_SECRET`、`ADMIN_TOKEN`，小程序登录再加 `WX_APPID`、`WX_SECRET`。用到 web-view 时加 `MP_VERIFY`（校验文件正文）。生产环境没有 `JWT_SECRET` 会直接退出。
4. 健康检查路径：`GET /api/health`。
5. 新库在进程启动时按 `sql/schema.sql` 建表。已有库的增量 SQL 放进 `sql/migrations/`，对这个库文件执行 `npm run db:migrate`。

启动前定好 `JWT_SECRET`：换新值等于所有用户被登出，沿用旧值则现有 token 继续有效。

业务域名校验文件由 `src/node.ts` 的 `/MP_verify_*` 出口返回（排在 SPA 兜底之前）。用 `MP_VERIFY`，或把 txt 放进 `public/`。

拿到外网地址后填两处：

- `miniprogram/config.js` 的 `PROD_API`
- 云函数环境变量 `BACKEND_ORIGIN`（体验版仍走云函数转发；Sealos 默认域名一般不能直接填进小程序服务器域名白名单）

---

## 接口约定

用户：`Authorization: Bearer <jwt>` + `X-Ledger-Id`  
管理员：`POST /api/v1/admin/login`  
健康检查：`GET /api/health`  
金额：整数分  
时间：UTC 毫秒，月份 `Asia/Shanghai`

小程序登录：`POST /api/v1/auth/wechat`，body `{ "code" }`。新 openid 建一个可单独使用的微信账号（201），已绑定过则直接进入合并后的账号（200）。会话里的 `user.has_password` / `user.wechat_bound` 用来决定要不要显示「绑定已有账号」。未配置 `WX_APPID` / `WX_SECRET` 时返回 503。`session_key` 不落库。

绑定已有账号：小程序登录后 `POST /api/v1/me/wechat/bind`，body `{ "username", "password" }`，带当前 Bearer，不需要 `X-Ledger-Id`。密码正确后两个账号合成一个：留下被绑定账号的用户名和密码，挂上当前微信。只有自己的账本并进对方最早的那个账本（同名账户、分类、联系人合并，余额和预算相加，流水、人情、周期记账、收据都保留）。还有别人的共享账本不搬流水，只把所有者改成合并后的这个人。返回**新 token**（必须替换本地旧 token）。之后微信登录和密码登录进入同一个账号。目标账号已绑过别的微信则 409，不覆盖。

web-view 会话交接：

- `POST /api/v1/webview/handoff`：小程序原生侧调用，Bearer 鉴权，账本可选（带了就校验成员身份并回传）。返回 `{ code, expires_in: 300 }`。
- `POST /api/v1/auth/webview-session`：网页侧调用，body `{ code }`，无需 Bearer（交接码即凭据）。返回完整会话，并多一个 `ledger_id`（小程序当时的账本），网页据此对齐首屏账本。码过期 / 已用过返回 401，形状不对返回 400。
- 库里只存 SHA-256，兑换用 `UPDATE ... RETURNING` 原子抢占，防并发重放。

页面归属表：

- `GET /api/v1/app/config`：小程序启动时拉取，返回 `{ webview: { enabled, host, pages } }`。
- `GET` / `PUT /api/v1/admin/app-config`：管理员读写。`host` 只接受 `https://<域名>`（无路径、无结尾斜杠）；`enabled=1` 而 `host` 为空会被拒；`NATIVE_ONLY` 里的页面切成 `webview` 会被拒。

拍照记账（图片识别）：

- `GET /api/v1/ocr/status` → `{ available }`。**免账本头但仍需登录**（`LEDGER_OPTIONAL`）。
- `POST /api/v1/ocr/scan`：认图 → `{ text, profile, chars }`。同时接受 `multipart/form-data`（字段 `file`）与 `application/json`（`{ image_base64, mime }`）——后者是给云通道用的，`wx.cloud.callFunction` 的 event 只送 JSON。图片上限 6MB，白名单 `jpeg / png / webp / bmp / heic`。
- `POST /api/v1/imports/receipt`：识别出的文本 → 流水行（与 `/imports/utterances` 同一条下游，只是提示词不同）。**没配 llm 时返回 `parser: 'none'` + 空 `items`**，界面据此把原文摆给用户，而不是吐出一堆错行。
- `GET` / `PUT /api/v1/admin/ocr`、`POST /api/v1/admin/ocr/test`：图片识别配置，最多 8 套，按数组顺序接力。

细节见 [docs/photo.md](docs/photo.md)。

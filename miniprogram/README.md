# 记账 · 微信小程序

原生小程序（WXML/WXSS/JS，无构建依赖），对齐 `web/` 的功能，复用同一套后端 API。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss     全局：启动、路由登记、主题
├── config.js                        环境切换 + 传输方式 + web-view 兜底配置
├── project.config.json / sitemap.json
├── cloudfunctions/
│   └── ledgerProxy/                 云函数：把请求转发到后端（免域名白名单，见「开发与联调」）
├── tools/
│   ├── check.mjs                    静态检查（语法/JSON/WXML/路径/两端契约一致性）
│   ├── smoke.mjs                    加载冒烟：用模拟微信环境把页面与组件真跑一遍
│   ├── gen-gbk-table.py             生成 utils/gbk-table.js（导入 CSV 要用）
│   └── gen-tabbar-icons.py          生成 tabBar 图标（避免手绘资源）
├── images/                          tabBar 图标
├── utils/
│   ├── request.js                  统一请求层：token、账本头、401 回登录
│   │                               （收据 / 语音的手工 multipart、认图的两条送法也在这里）
│   ├── image.js                    拍照 / 选图 → 压到能送出去的体积（唯一允许调
│   │                               wx.chooseMedia / wx.compressImage 的地方）
│   ├── transport.js                传输层：direct（wx.request）/ cloud（云函数）分流与降级
│   ├── session.js                  token / 当前账本 / 用户 / 账本列表
│   ├── appConfig.js                「页面归属表」缓存（原生 or web-view）
│   ├── nav.js                      页面跳转统一入口（唯一知道归属表的地方）
│   ├── webview.js                  web-view 会话交接（一次性码）
│   ├── money.js / time.js          金额与日期（与后端 src/money.ts、src/time.ts 对拍）
│   ├── ui.js                       toast / 确认框 / 输入框 / 选择器（Promise 化）
│   ├── fileText.js                 账单文本编码嗅探（UTF-8 / GBK）
│   ├── gbk.js                      GBK 解码
│   └── gbk-table.js                GBK → Unicode 表（微信没有 TextDecoder）
├── components/                      month-nav / add-sheet / ai-panel
└── pages/                           见下
```

## 页面登记

| 页面 | 现状 | 归谁 |
|------|------|------|
| `home` | ✅ 明细：月切换（可跳年月）、收支与预算、流水/日历/统计三视图、搜索筛选 | 原生 |
| `tx-form` | ✅ 记一笔：支出/收入/转账、日期快捷、收据图、再记一笔 | 原生 |
| `favors` / `favor-person` / `gift-form` | ✅ 人情往来、联系人、某人明细 | 原生 |
| `assets` / `budgets` / `categories` / `recurring` | ✅ 资产、月预算、分类、周期记账 | 原生 |
| `speak` / `import` | ✅ 智能记账（说话或拍一张）、账单导入（含批次撤销） | 原生 |
| `me` / `ledger` | ✅ 我的、账本与成员 | 原生 |
| `login` | ✅ 微信一键登录 + 账号密码 + 绑定已有账号 | 原生 |
| `webview/webview` | ✅ 通用网页容器 | 承载长尾页 |

以上页面**全部**在 `src/routes/webview.ts` 的 `NATIVE_ONLY` 里，服务端会拒绝把
它们切成 web-view——依赖 `wx.login` / 录音 / 拍照 / 选图 / 选文件的页面切过去就是废的。

**账本切换只有一个入口：`我的 → 账本与成员`。** 明细 / 人情 / 资产这三个 tab 页
**不放**切换入口（`ledger-bar` 组件已删除）。三个页面的 `onShow` 都会重拉自己的数据，
所以切完账本回来是新的；但明细页的账户 / 分类是**按账本缓存**的，所以 `home.js` 在
`onShow` 里比对 `ledgerId`：变了就清掉筛选条件、重拉账户与分类、**再**拉一次流水
（顺序不能反，否则流水的分类名还是旧账本的映射）。`check.mjs` 会拦住往 tab 页加回
切换组件的写法。

**月份切换条只有 `components/month-nav` 一处实现。** 明细 / 预算 / 人情三页都用它，
别再在页面里手写（组件样式是隔离的，页面里那份对组件不生效）。要点：

| | 说明 |
|---|---|
| 点中间的月份 | 弹「年 / 月」双列滚轮，直接跳过去 —— 这是它相对旧版唯一的交互增量 |
| `month` | 当前月份，由**页面**持有；组件只显示并派发 `bind:change` |
| `max` | 可选上限，默认本月。**预算页传「下个月」**：它是唯一允许提前设预算的页面 |
| 年份范围 | 近 10 年（`time.YEAR_SPAN`），上限那年只排到上限月，永远选不到未来 |
| 「回到本月」 | 只在不在本月时自动出现，不需要页面控制 |

`time.js` 的 `pickerYears / pickerMonths / pickerIndex` 是它的数据源，边界都在
`test/miniprogram-utils.test.ts` 与 `test/miniprogram-month-nav.test.ts` 里钉着。
`check.mjs` 第 11 条会拦住三种回退：旧的 `.month`、页面手写 `.month-nav`、
以及某个页面漏掉月份切换。

## 提交前跑什么

```bash
npm run check:miniprogram
```

两个脚本串联：`check.mjs` 做静态检查（含 WXML 标签配平、插值里禁用 `Math` / 箭头函数 /
模板串、tabBar 图标体积、`usingComponents` 可达、账本切换入口约定），`smoke.mjs` 用一套模拟的微信环境
把 15 个页面与 2 个组件真正 `require` 一遍，核对 `Page` / `Component` 注册形状与
`this.xxx()` 是否有定义。

**为什么要冒烟而不只是 `node --check`**：语法检查看不到「模块顶层代码执行就抛异常」，
而小程序里模块是页面加载时求值的，顶层一抛就是白屏，日志还指向编译输出，很容易被
当成语法问题去查。

## 编译失败怎么查

微信开发者工具报「编译失败」时，按这个顺序对，绝大多数是第一条：

| 现象 | 原因 |
|------|------|
| 某个页面/组件「未找到」 | `app.json` 的 `usingComponents` 指向尚未创建的组件目录，或 `pages` 里登记的页面缺 `.js` / `.json` / `.wxml`。**后者是增量开发的常态**：先登记后建文件，中间任何一次编译都会失败 |
| WXML 编译报错但指不到具体行 | 插值里写了 `Math`、箭头函数、模板字符串，或标签未配平。跑 `check.mjs` 能直接定位 |
| 「不在以下 request 合法域名列表中」 | 这是运行时报错不是编译失败。开发时勾「不校验合法域名」，真机必须配域名 |
| 项目打不开 / 提示不是小程序项目 | 导入时选错了目录。项目根必须是 `miniprogram/`（`project.config.json` 在这里），不是仓库根 |

```bash
# 定位用：先跑本地检查，它会指到具体文件
npm run check:miniprogram
```

## 渲染踩过的三个坑

都是「编译通过、模拟器看着还行，真机／细看才发现」的类型，改完记得对照一眼。

**1. `<input>` 必须给显式高度。** 小程序 input 的高度只由字号撑开，写
`padding: 24rpx` 会把内容区压到小于行高，**文字上下被裁掉**（现象是「输入框里的字有遮挡」）。
所以 `.input` 统一 `height` 定高、`padding` 只做左右（见 `app.wxss`）；
自己起类名的 input 也一样——`import.wxss` 的 `.imp-amount`、
`ai-panel.wxss` 的 `.ap-amount` / `.ap-note` 都显式定了高度。

**2. WXML 插值里不能调用函数。** `{{accountNameOf(accountId)}}` 不报错、编译也过，
只会**安静地渲染成空字符串**（「账户下拉框显示空白」就是它）。文本、下标一律在 js 里
算好放进 `data`。`check.mjs` 现在会拦住这种写法。

**3. 下拉框（picker）的三件事。**
- `value` 要传**下标**：不传的话每次打开都从第一项开始，看着像「选错了」。
- 值要能省略（`.val` + `text-overflow: ellipsis`），否则长分类名会把 `▾` 挤走并换行。
- 并排的筛选框，两个筛选项的显示名要**各存各的**：共用一个字段会出现
  「选了账户，分类那栏显示账户名」。


## 开发与联调

```bash
# 1. 起后端（仓库根目录）
npm run db:local     # 首次或 reset
npm run dev          # wrangler dev --env local，默认 http://127.0.0.1:8787

# 2. 开发者工具导入本目录
#    详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」

# 3. 小程序内切环境：我的 → 开发者 → 环境 → 本地 / 线上
```

`config.js` 里 `local` 指 `http://127.0.0.1:8787`，`prod` 指线上。

**切环境别把自己锁在外面**：环境值存在本地缓存（`ledger.env`）里，而切换入口在「我的」——
登录之后才进得去。误切成「本地」后登录请求发不出去，就回不到「我的」改回来。所以
**登录页底部会在指向非线上时显示当前环境 + 「切回线上」按钮**（指向线上时不出现，不影响正常用户）。
真在登录页卡住了，两条路都行：

- 点登录页那个「切回线上」；
- 或开发者工具「清缓存 → 清除数据缓存」（清掉 `ledger.env` 后会回落默认值 `prod`）。

`check.mjs` 第 14 条会拦住「把登录页那个出口删掉」的改动。

### 域名校验：为什么体验版离不开「真机调试」

**现象**：只有从开发者工具发起的「真机调试」能跑通，关了工具（或体验版正常打开）就报
`request:fail url not in domain list`。

**原因**：`project.config.json` 里的 `urlCheck: false`（= 工具里那个「不校验合法域名」）**只对两处生效**：工具模拟器、从工具发起的真机调试。真机调试本质是远程调试，代码和设置都来自本地工程，所以电脑一关就断。体验版 / 正式版由微信客户端自己发请求，会严格比对「服务器域名」白名单。

**而白名单现在填不进去**：微信要求 request 合法域名必须已完成 ICP 备案，但 `ledger.hxsmj.top` 的 NS 在 Cloudflare、后端也是 Cloudflare Worker —— 没有境内接入商，备案走不通。所以这不是漏配，是结构上过不去。

**解法：云函数中转**（`utils/transport.js` + `cloudfunctions/ledgerProxy/`）。

```bash
# 1. 小程序后台 → 云开发 → 新建环境，拿到环境 ID（形如 ledger-3gxxxxxxxx）
# 2. 把 ID 填进 config.js 的 CLOUD_ENV
# 3. 开发者工具里右键 cloudfunctions/ledgerProxy → 上传并部署（云端安装依赖）
# 4. 编译后用体验版真机验证：不开「开发调试」也要能登录
```

- 云函数出网**不受小程序域名白名单约束**，所以这个方案免域名、免备案。
- `CLOUD_ENV` 留空时 transport 自动降级成直连，行为与改造前一致 —— 开发者工具和真机调试照旧能用，不会因为没配云开发而卡死开发流程。
- 云函数里**不要**从 `event` 读转发原点（会变成任意 URL 跳板，`check.mjs` 第 12 条会拦）。要换后端改云开发控制台的环境变量 `BACKEND_ORIGIN`。
- 云通道只送 JSON。收据图 / 语音这类二进制上传目前显式报「暂不支持」，正确做法是走云存储中转（`wx.cloud.uploadFile` → 云函数 `cloud.downloadFile` 后自己拼 multipart）。
- **降级不覆盖超时**：只有「云函数压根没发出去」（未开通 / 未部署 / 网络失败）才改走直连重试。超时说明请求可能已经落库，重试会重复记一笔。
- 长期正路仍是备案 + 境内接入：域名在境内云厂商完成 ICP 备案后配进白名单，这一层就能去掉。

### 将来备案后的域名配置

微信后台 → 开发管理 → 开发设置：

| 类型 | 填什么 |
|------|--------|
| request 合法域名 | `https://<已备案的 API 域名>` |
| uploadFile 合法域名 | 同上（收据图上传） |
| downloadFile 合法域名 | 同上（收据图查看） |
| 业务域名 | `<web-view 要加载的域名>`，**仅非个人主体可配** |

目前所有请求都走 `wx.request`，所以只需要配 request 一类。

## 微信登录开通

链路是：`wx.login` 拿 code → 小程序 `POST /api/v1/auth/wechat` → 服务端调微信 `jscode2session` 换 openid。**三处必须指向同一个 AppID**，任一处不对都表现为「登录一直失败」且看不出原因：

| 位置 | 填什么 |
|------|--------|
| 微信后台 → 开发管理 → 开发设置 | AppID / AppSecret 的出处 |
| `project.config.json` 的 `appid` | 就是这个 AppID |
| Cloudflare 的 `WX_APPID` / `WX_SECRET` | 同上，用 `wrangler secret put` 配，**不要写进仓库** |

AppID 与 `WX_APPID` 不一致时微信回 `40013 invalid appid`，服务端映射成 `503 wechat_config_invalid`。

```bash
cd <仓库根>
printf '<AppID>'    | npx wrangler secret put WX_APPID  --env=""
printf '<AppSecret>' | npx wrangler secret put WX_SECRET --env=""
```

`--env=""` 不能省：配置里定义了多环境，不显式指定会警告（甚至配错环境）。**改 secret 不用重新 deploy**，Cloudflare 会自动发布新版本；但**改代码必须 deploy**。

### 配完怎么验（不用真机）

拿一个无效 code 打线上，响应码就能区分三种状态：

```bash
curl -s -o - -w "\nHTTP %{http_code}\n" -X POST https://<API 域名>/api/v1/auth/wechat \
  -H "content-type: application/json" -d '{"code":"probe_invalid_code"}'
```

| 返回 | 含义 |
|------|------|
| `503 wechat_unconfigured` | 两个 secret 没配齐 |
| `503 wechat_config_invalid` | 配了，但 AppID / AppSecret 不对 |
| `401 wechat_code` | **配对成功** —— 微信已正常应答，只是这个 code 是假的 |

### 排查「线上还是老行为」的第一步

**先确认线上跑的是哪版代码**，否则会在业务代码里白找。

判断方法：**只能看免鉴权路由**。`/api/v1/*` 未登录一律 401，所以 401 只说明中间件在，**不能**判断路由是否存在；只有 `/auth/login`、`/auth/register`、`/auth/wechat` 的响应码才有版本区分度。

### 首次微信登录会得到「新账号」

已经用用户名密码记过账的人，第一次点微信一键登录**会进一个空的新账号**——不是数据丢了，是两个账号还没合并。合并方式：微信登录 → 我的 → 绑定已有账号 → 填原用户名密码（`POST /api/v1/me/wechat/bind`），成功后**必须替换本地 token**。

## 静态检查

```bash
node miniprogram/tools/check.mjs
```

检查四件事：JS 语法、JSON 可解析、`app.json` 登记的页面/组件文件是否齐全、`require` 相对路径是否可达。另外还核对两个**跨端契约**，这两处不一致会直接导致线上白屏且很难查：

- 服务端 `src/routes/webview.ts` 里可切 web-view 的页面，`utils/nav.js` 必须有对应的原生兜底路径；
- 交接码查询参数名，小程序 `utils/webview.js` 与网页 `web/src/bridge.ts` 必须一致。

---

## web-view 混合架构

**定位**：网页只承载「长尾页」，高频操作留在原生。这不是省事的中间态，而是必须——微信《运营规范》第 8 条把「内嵌网页规避平台规则」列为违规，首页即网页、没有实质原生功能的纯套壳小程序会被驳回。

### 哪些页能切 web-view，谁说了算

「页面归属表」在**服务端**（`app_configs` 表），不在代码包里：

```
GET /api/v1/app/config            小程序启动时拉一次，结果缓存在 storage
PUT /api/v1/admin/app-config       运维改归属，deploy 即生效
```

默认全部原生。可以切 web-view 的只有 5 个长尾页：`budgets` / `categories` / `recurring` / `import` / `ledger`。`NATIVE_ONLY` 里的页面（登录、明细、记账、人情、资产、我的、语音）服务端**拒绝**切——它们依赖 `wx.login` / 录音 / 拍照 / 选图，切成网页会直接不可用。

归属表的键是「页面语义」，值是网页路由，所以**网页路由改了也不用发版**：

```json
{ "webview": { "enabled": true, "host": "https://ledger.example.com",
  "pages": { "budgets": { "mode": "webview", "path": "/budgets" } } } }
```

### 启用前置条件（缺一不可）

1. **主体是非个人**（企业 / 个体户）。个人主体**配不了业务域名**，`<web-view>` 打不开自己的网页——这一条卡死了整套方案，不是「先去备案就行」。
2. 域名已 **HTTPS 化**，且 **ICP 备案主体与小程序认证主体一致**。
3. 该域名在微信后台登记为**业务域名**，且校验文件能从**域名根目录**取到。

### 第 3 步的两个坑

**坑一：校验文件会被 SPA 兜底吃掉。** `wrangler.toml` 里 `not_found_handling = "single-page-application"`，请求 `/MP_verify_xxxx.txt` 找不到文件就会返回 `index.html`，微信校验必然失败。已经把 `/MP_verify_*` 加进 `run_worker_first`，并在 `src/index.ts` 里做了兜底出口。

两种放法，任选其一：

```bash
# 推荐：写进变量，不用重新构建前端产物
npx wrangler secret put MP_VERIFY     # 粘贴校验文件里的纯文本内容
# 或者：把 txt 原样丢进 public/
```

**坑二：web-view 里没有 `wx.login`。** 网页拿不到 code，现有「`wx.login` → `/auth/wechat`」这条登录链路在网页里直接断掉。解法见下。

### 会话交接（一次性码）

```
原生（已登录）               服务端                     网页
     │                        │                        │
     │ POST /webview/handoff  │                        │
     │ ─────────────────────► │ 存 SHA-256(code)        │
     │ ◄───────────────────── │ 5 分钟 / 用一次即失效     │
     │                        │                        │
     │ 拼接 src = host + path + '?handoff=<code>'      │
     │ ──────────────────────────────────────────────► │
     │                        │ ◄── POST /auth/webview-session {code}
     │                        │ ──► 会话（token/user/ledgers/ledger_id）
```

- 明文 code 只在签发响应里出现一次，库里只存 SHA-256；
- 5 分钟过期，用一次即失效（`UPDATE ... RETURNING` 原子抢占，防并发重放）；
- `ledger_id` 会跟着回来，网页首屏就落在小程序当时的账本上，不会跳账本；
- 不做「同域 cookie 共享」——以后 API 换域名时这套不依赖同域假设。

### 打开 web-view 的操作步骤

```bash
API=https://ledger.hxsmj.top

# 1. 拿管理员令牌（口令是服务端的 ADMIN_TOKEN）
TOKEN=$(curl -s -X POST $API/api/v1/admin/login \
  -H 'content-type: application/json' -d '{"password":"<ADMIN_TOKEN>"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 2. 配域名 + 打开总开关（此时所有页仍是原生）
curl -s -X PUT $API/api/v1/admin/app-config \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"webview.host":"https://ledger.example.com","webview.enabled":"1"}'

# 3. 灰度：一次只切一页，先拿预算试
curl -s -X PUT $API/api/v1/admin/app-config \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"webview.pages":{"budgets":{"mode":"webview","path":"/budgets"}}}'

# 4. 出问题就单页回退，不用发版
curl -s -X PUT $API/api/v1/admin/app-config \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"webview.pages":{"budgets":{"mode":"native"}}}'
```

`host` 只接受 `https://<域名>`（不带路径、不带结尾斜杠），写错会被拒。`enabled=1` 但 `host` 为空也会被拒——服务端不会下发一个必然打不开的地址。

### 网页端要遵守的两条约定

1. 底部导航在 web-view 里点击 = **交回原生页**（`web/src/pages/Shell.vue`）；加号一律走原生记账表单。网页版是「进去看一眼就退回来」的长尾页，不是和原生并行的一套壳。
2. 从原生页返回 web-view 时网页不会重新加载，靠 `visibilitychange` 触发一次数据刷新（`web/src/bridge.ts`）。

## 与 H5 的差异

| 项 | H5 (`web/`) | 小程序 |
|----|-------------|--------|
| 登录 | 用户名密码 | 微信一键登录，支持绑定已有账号 |
| 收据 | `<input type=file>` | 拍照 / 相册，手工拼 multipart（不能用 `wx.uploadFile`，它给不对分片类型） |
| 语音 | `MediaRecorder` | `wx.getRecorderManager`（mp3） |
| 拍照记账 | 未做 | `components/ai-panel`：拍照 → `utils/image` 压图 → `/ocr/scan` → `/imports/receipt` |
| 账单导入 | `<input type=file>` + FileReader | `wx.chooseMessageFile` + 自建 GBK 解码表 |
| 存账单 | 导出 CSV（含 GBK） | 未做，手机上不需要 |
| 长尾页 | 全量 | 可切 web-view，复用同一份 `web/` 代码 |

## 智能记账：说话或拍一张

两条入口汇到同一套核对 / 提交界面（`components/ai-panel`），差别只在拿文字的
那一步：语音走 `/speech/transcribe`，拍照走 `/ocr/scan`。

**拍照这条链路的四件事**

1. **只允许 `utils/image.js` 调 `wx.chooseMedia` / `wx.compressImage`。**
   手机直出的照片 3–8MB，后端上限 6MB、云通道的 event 上限约 1MB（base64 再胀 1/3）。
   绕开它就没有体积守卫，症状是「开发者工具里好好的，体验版拍照必失败」。
   `check.mjs` 第 16 条会拦。
2. **目标体积跟着通道变**：直连 3MB，云通道 600KB（`request.imageLimit()`）。
   压缩梯度先降质量、再降分辨率 —— 小票上真正要读的是数字。
3. **压缩后的类型按文件头猜**（`image.mimeOf`），不信扩展名：`compressImage`
   的输出格式随机型变化，而 multipart 分片的 `Content-Type` 是我们自己写死的。
4. **图片不留存**：只在这次请求的内存里过一遍，不落库、不进云存储。

**只配了图片识别、没配文本解析模型时**，能认出字但整理不成流水。这时后端返回
`parser: 'none'` + 空 `items`，浮层会把识别出的原文整段摆出来（可一键复制），
让人照着手动记 —— 比吐出一堆错行让人逐条删要好。准确率与配额说明见
[`docs/photo.md`](../docs/photo.md)。

配置入口：管理后台 → 「图片识别」。默认预填硅基流动的
`PaddlePaddle/PaddleOCR-VL-1.5`，和语音一样支持多套接力。

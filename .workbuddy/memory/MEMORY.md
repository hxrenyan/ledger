# 记账 · 项目长期记忆

## 拍照记账：两步、两个模型（2026-09-23 加）

```text
照片 → /ocr/scan（kind=ocr，只发图不发文字指令）→ 纯文本
     → /imports/receipt（kind=llm，票据提示词）→ 核对 → /imports/commit
```

**第一步别给提示词**：PaddleOCR-VL 是按「只发图片」训练的，补一句「请提取 JSON」反而跑偏。
结构化全交给第二步。**只配 ocr 没配 llm = 认得出字但整理不成流水**，后端返回
`parser:'none'` + 空 items + `ai_error`，浮层把原文整段摆出来让人照手动记。

- **`utils/image.js` 是唯一允许调 `wx.chooseMedia` / `wx.compressImage` 的地方**，
  `check.mjs` 第 16 条会拦。绕开它就没有体积守卫：手机照片 3–8MB，后端 6MB、
  云通道 event 约 1MB（base64 再胀 1/3），症状是「工具里好好的、体验版拍照必失败」。
- **目标体积跟着通道变**（`request.imageLimit()`：直连 3MB / 云 600KB）。
  梯度**先降质量、再降分辨率**（先缩图会糊掉小票上的数字）；起点由 `startStep()`
  按最坏情况估算再**往前让一档**，真机逐档压完核对实际体积。
- **类型按文件头猜**（`image.mimeOf`），不信扩展名：`compressImage` 输出格式随机型变化，
  而 multipart 分片的 `Content-Type` 是自己写死的。
- `/ocr/scan` **同时收 multipart 与 JSON base64**（后者给云通道，callFunction 只送 JSON），
  两条路进同一个函数。`/ocr/status` 免账本头但**仍要登录**（写测试时踩过）。
- 图片不留存：只在当次请求内存里过一遍。
- **H5 也有这个入口**（加号浮层 + 智能记账整页），位置与小程序一致。压图分两个文件：
  `web/src/photoSteps.ts`（决策，纯函数）+ `web/src/photo.ts`（canvas 执行）。
  梯度与小程序那份**必须一起改**，`test/web-photo.test.ts` 有跨端一致性断言钉着。
- **canvas 转 jpeg 前必须先铺白底**：截图多是 png，透明区会变黑，正好糊掉小票上的字。
- **`input[type=file]` 选完要清 `value`**（集中在 `ShotButton.vue`），否则重选同一张
  不触发 `change`，表现是「再点一次没反应」。

## web-view 混合架构（2026-09-23 定）

**页面归属表是服务端数据，不是代码。**「某页走原生还是 web-view」存在 `app_configs` 表，
`GET /api/v1/app/config` 下发，`PUT /api/v1/admin/app-config` 改，deploy 即生效、
**不发版不审核**。默认全原生，`webview.enabled=0` 就是纯原生。

1. **页面跳转必须走 `miniprogram/utils/nav.js` 的 `nav.go(key, query)`** —— 唯一知道归属表
   的地方。直接 `wx.navigateTo` 会让切换失效，且只在服务端切了归属后才暴露。
2. **新增可切 web-view 的页面要同步改三处**：`src/routes/webview.ts` 的 `WEBVIEW_PAGES`、
   `nav.js` 的 `NATIVE_PAGES`、`config.js` 的 `WEBVIEW_PAGES`。依赖 `wx.login` / 录音 /
   拍照 / 选图 / 选文件的页面**不许**加（服务端 `NATIVE_ONLY` 会拒）。
3. **跨端契约两端一起改**：交接码参数名（`miniprogram/utils/webview.js` ↔ `web/src/bridge.ts`）。

**不能做纯壳**：业务域名仅非个人主体可配（备案解决不了主体问题），运营规范也禁止用内嵌
网页规避平台规则。分工：逻辑与配置下沉服务端（免审）→ 微信能力留原生 → 长尾页走 web-view。

**web-view 里的登录**：网页没有 `wx.login`，靠一次性交接码（原生
`/api/v1/webview/handoff` → 网页 `/api/v1/auth/webview-session`），5 分钟过期、一次即失效、
库存 SHA-256、`UPDATE ... RETURNING` 原子抢占。别改成同域 cookie 共享。

## 必踩的坑

- **401 只能表示「未认证」**：凡是「已认证、但请求不合法或上下文缺失」一律用 400，
  否则客户端会当成掉登录 → 清会话 → 跳登录页。曾因「缺 `X-Ledger-Id`」返回 401，
  用户刚微信登录进明细就被踢回登录页；另外客户端 401 处理要校验「请求发出时的 token
  仍等于当前 token」，否则登录前发出的迟到 401 会误伤刚建立的新会话。

- **收据上传**：接口读的是 multipart **分片自己的** Content-Type（jpeg/png/webp 白名单），
  所以手工拼 multipart（`utils/request.js` 的 `uploadReceipt`），**不要换 `wx.uploadFile`**。
- **WXML 表达式很窄**：没有 `Math`、箭头函数、模板串、`new Date`、`JSON`，**也不能调用
  页面方法**（`{{fn(x)}}` 不报错、安静渲染成空，曾害得账户下拉框一片空白）。都在 js 里算好
  再 `setData`；写错不提示行号而是整页失败。插值里的 `>` 会干扰标签解析，先剔除 `{{}}`。
- **`<input>` 必须给显式高度**：input 的高度只由字号撑开，写 `padding` 会把内容区压小、
  文字上下被裁（就是「输入框的字有遮挡」）。统一 `height` + 只做左右 padding。
  picker 的 `value` 要传**下标**（不是 id），值要能省略，否则长名字会把 `▾` 挤走换行。
- **`wx:for` 的默认变量名是 `item`**：要改名必须显式写 `wx:for-item="cell"`，否则
  `{{cell.day}}` 静默取到 undefined —— 不报错、不提示行号，只是渲染成空（明细页
  「日历一片空白」就是这么来的：`<block wx:for="cells">` 忘了写 for-item，
  格子全渲染成没有数字的空框）。`check.mjs` 第 15 条会拦这类「插值变量没声明」。
- **`.row` 是 flex 行容器，里面不能再套 `.row`**：内层（尤其 `wx:for` 循环出来的多个）
  会变成同一个 flex 行的子项、横向挤在一起。明细页「日历点开某天，几笔记录挤成一行」
  就是这个写法。要竖排就让 `.row` 直接挂在 `.card` 这种普通块级容器下。
  `check.mjs` 第 13 条会拦。日历 7 列用 `flex: 0 0 14.2857%` 定死，别用 `width: 14.28%` 凑整。
- **日历格子只依赖月份，与请求解耦**：先 `buildCells()` 画格子（`onLoad` / `changeMonth`），
  `loadMonth` 成功后再补「哪天有流水」的标记。若把 cells 塞进 loadMonth 的 setData，
  接口挂了日历就是一片空白（只剩表头）。**周起点是周一**，表头顺序也从 `time.CAL_WEEK`
  取（只有一处定义），别在 wxml 里硬编码七个 `<view class="w">`。
- **日历默认选中「今天」**：`autoSelectToday()` 在 `switchView('cal')` 和 `loadMonth`
  成功后被调用，三个前提（在日历视图 / 本月 / 还没选过任何一天）缺一不可 —— 历史月份里
  没有今天，用户点过某天时也不能被覆盖。当天明细直接用已加载的本月流水在本地筛，
  **不额外发请求**。今天在没被选中时靠 `.d.today` 的小圆点辨认（选中态圆点转白）。
  `test/miniprogram-home-calendar.test.ts` 用 6 个用例钉住这些边界。
- **编译失败先跑 `npm run check:miniprogram`，别猜。** 最隐蔽的是**增量开发的中间态**：
  `app.json` 的 `pages` / `usingComponents` 先登记、文件后创建，窗口期编译必然硬失败。
  项目根必须是 `miniprogram/`，不是仓库根。
- **根 tsconfig 的 lib 只有 ES2022、没有 DOM**：`test/` 下直接 import web 里碰
  `document` / `Image` / canvas 的模块，`npm run typecheck`（根 tsc）会报
  `Cannot find name 'document'`。要测就把纯逻辑拆成单独文件（如 `web/src/photoSteps.ts`），
  别让 test/ 引到浏览器 API。`typecheck:web` 用的是 `web/tsconfig.json`，那边有 DOM。

## 请求怎么送出去：传输层（2026-09-23 加）

`utils/request.js` 不直接调 `wx.request`，而是走 `utils/transport.js`，由它按
`config.getTransport()` 分流：`direct`（wx.request）/ `cloud`（云函数 `ledgerProxy`）。

**为什么有 cloud**：体验版 / 正式版严格校验「服务器域名」白名单，而白名单要求域名已
ICP 备案 —— `ledger.hxsmj.top` 的 NS 在 Cloudflare，没有境内接入商，备案走不通。
所以线上把请求交给云函数出网转发。`config.js` 的 `CLOUD_ENV` 留空时自动降级为直连，
开发流程不受影响（开发者工具 + 真机调试本来就走免校验通道）。

三条硬规则：
1. **超时绝不降级重试**：云函数超时 = 请求可能已落库，重试就是重复记一笔。只有
   「压根没发出去」才 fallback。`test/miniprogram-request.test.ts` 有用例钉着。
2. **云函数不许从 `event` 取转发原点**（否则是任意 URL 跳板），要改后端用云开发
   控制台的环境变量 `BACKEND_ORIGIN`。`check.mjs` 第 12 条会拦。
3. **云函数目录必须在 `miniprogram/` 里**（本项目根是 `miniprogram/`），
   `cloudfunctionRoot: "cloudfunctions/"`，微信工具不认 `../`。

云通道只送 JSON；收据 / 语音这类二进制上传要接的话走云存储中转
（`wx.cloud.uploadFile` → 云函数 `cloud.downloadFile` 后自己拼 multipart）。
**认图已经用 JSON base64 绕开了这条限制**（`request.scanImage`），收据与语音还没绕。

**给人体验只能靠体验版**：真机调试 / 预览码都不行（扫码者须是项目成员、调试会话 1:1、
预览码约 25 分钟过期、全程依赖你电脑开着 IDE）。上传 → MP 后台设为体验版 → 加体验成员
（个人主体上限 15 人，以后台实际为准）→ 分享体验版码，长期有效。**推论**：`CLOUD_ENV`
不填就不会有可用的体验版 —— 体验版是真实客户端，无免校验通道。

## 环境切换有个死锁（2026-09-23 修）

环境（本地 / 线上）存在**本地缓存** `ledger.env` 里，切换入口在「我的 → 开发者 → 环境」，
而那页要登录之后才进得去。误切成「本地」（指向 `127.0.0.1:8787`）后登录请求发不出去 →
回不到「我的」→ 改不回来，整个小程序锁死在登录页（用户报的「切成本地后微信登不上去」
就是这个，不是登录本身坏了）。

所以 **`pages/login` 在指向非线上时必须显示当前环境 + 「切回线上」**
（`syncEnv()` / `backToProd()`；切回时一并 `session.clear()` + `appConfig.clearCache()`，
因为归属表是服务端下发的，token 也不属于新后端）。`check.mjs` 第 14 条钉住这个出口。
应急也可以开发者工具「清缓存 → 清除数据缓存」——清掉 `ledger.env` 后回落默认 `prod`。

## 月份切换只有 `components/month-nav` 一处实现

明细 / 预算 / 人情三页共用。**页面里不要再手写 `.month-nav`** —— 组件样式是隔离的
（`app.wxss` 里的类名对组件无效），写两份必然对不上，那份样式已从 `app.wxss` 删掉。

- **月份由页面持有**：组件只显示 + `bind:change` 报月份。切月往往要连带重置筛选、
  清选中日、重拉数据，那是页面的决定。三页各自把 `prev/next/changeMonth` 收敛成
  **`onMonthChange(e)`**（`changeMonth` 在 home 里保留为内部方法）。
- **`max` 属性决定上限**，默认本月。**预算传「下个月」**——它是唯一允许提前设预算的页面。
  明细 / 人情不传，所以永远选不到未来。
- 点中间的月份弹**双列滚轮**（`picker mode="multiSelector"`），这是相对旧版唯一的交互增量。
  数据源是 `time.pickerYears / pickerMonths / pickerIndex`（`YEAR_SPAN = 10`）。
  上限那年只排到上限月 —— 「不出现未来月份」只在 `pickerMonths` 里判断一次，别在页面里
  再写一遍。`onPick` 必须按选中年份**自己重算**月份列再取值，不能直接拿
  `e.detail.value[1]` 索引（列变化事件不保证来得及截断）。
- **`emit` 要自己挡越界**：置灰的按钮只挡点击、挡不住代码，页面不该收到越界月份。
- 箭头仍是 `.ico` / `.ico-next`（两条边框转 45°），别写字体的 `‹ ›`；
  `.month + space-between`（两个圆按钮被甩到屏幕两边）是更早的旧写法。
- 人情页的月份筛选在**本地**做（`GET /gifts` 没有 month 参数，返回全量），
  汇总也必须在 `applyFilter` 里跟着月份重算，留在 `load()` 里会「列表变了、汇总不动」。
- `check.mjs` 第 11 条拦三种回退：旧 `.month`、页面手写 `.month-nav`、某页漏掉月份切换；
  `test/miniprogram-month-nav.test.ts`（10 例）钉住截断与钳位。

## 账本切换只有一个入口

`我的 → 账本与成员`。明细 / 人情 / 资产三个 tab 页**不放**切换条
（`components/ledger-bar` 已删，`check.mjs` 第 10 条会拦住加回去的写法）。
切账本后各 tab 靠 `onShow` 重拉；`home.js` 还要多做两件事：比对 `ledgerId` → 清筛选 →
**先 `loadRefs()` 再 `loadMonth()`**（筛选值与账户/分类映射都是账本内的，顺序反了会出现空列表或分类名对不上）。

## 上线清单（提交 + 部署）

```bash
npm run typecheck && npm run typecheck:web && npm test && npm run check:miniprogram
```

**本机跑测试必须加 `--pool=forks --poolOptions.forks.singleFork=true`** —— 默认并行池
会被环境杀掉（exit 137）。看到 137 是环境问题，不是测试坏了，别去改测试。

顺序与两个判断点：

1. **有新增表就先跑远程迁移**（`node scripts/d1-migrate.mjs --remote`），**再 deploy** ——
   反了的话新代码查不到表会 500。复用已有表（如 OCR 复用 `ai_profiles`，其 `kind` 无
   CHECK 约束）就**不要**跑，凭空多一次写远端的机会。
2. `npm run deploy`（= `build:web` + `wrangler deploy --env=""`）。
3. commit + `git push origin main`。提交前扫一眼暂存区有没有硬编码密钥：
   `git diff --cached | grep -nEi 'sk-[a-z0-9]{16,}|api[_-]?key.*=.*[a-z0-9]{16,}'`。
   **AppSecret / API Key 只进 `wrangler secret` 或后台 ai_profiles，绝不入仓库。**
4. 验线上：首页 `curl -o /dev/null -w '%{http_code}'` 看 200；
   探新版是否上线看 `401` 与 `404` 的区别 —— 但**未登录时的 401 只证明「路由存在且被
   认证中间件拦下」，证明不了业务可用**（`/api/v1/*` 一律先过认证）。要验完整性必须带 token。
   确认前端资源真的换了，就直接拉线上产物比对文案：
   `curl -s https://ledger.hxsmj.top/assets/<文件名>.js | grep -o "<新文案>"`。
5. **查线上数据/配置直接读 D1，别猜**：
   `npx wrangler d1 execute ledger-db --remote --command "SELECT ..."`。
   注意**本地 `.dev.vars` 的 `ADMIN_TOKEN` 与线上不是同一个**，拿它调线上 `/api/v1/admin/*`
   只会 401；读 D1 走的是 Cloudflare 账号凭据，不需要任何 token。
   「某个功能没生效」先这样查一遍服务端配置，往往当场就能排除一半可能。

`check:miniprogram` = `check.mjs`（16 条：语法/JSON/WXML 表达式与函数调用/插值变量声明/
路径/两端契约/账本切换入口/月份条/云函数 SSRF/图片入口收敛）
+ `smoke.mjs`（模拟微信环境把 19 模块 3 组件真 require 一遍，验注册形状与 `this.xxx()`）。
**冒烟不能省**：语法检查看不到模块顶层抛异常，而小程序模块是页面加载时求值的，一抛即白屏。
注意 `Component` 的方法在 `methods` 里、内置方法要白名单，否则全是误报。
**新加的 check 规则必须用故意写坏的文件验证真会报错**再还原 —— 曾因路径漏一层被
`existsSync` 跳过、检查器空转。

**`miniprogram/project.private.config.json` 是开发者工具的本地私有配置**（libVersion、
编译开关），随各人环境产生噪音 diff，惯例是忽略。当前**已入库**，要收干净就
`.gitignore` + `git rm --cached`（文件留本地）。

## 数据库

表之间不定义外键，只留 `*_id` 逻辑关联；多语句写入走 D1 `batch`。
表结构权威是 `sql/schema.sql`，增量同步改 `sql/migrations/`；
`src/db/patch.ts` 是已有库的运行时补丁（Worker 不能读 sql 文件）。

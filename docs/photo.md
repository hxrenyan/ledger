# 拍照记账（图片识别）

拍一张小票 / 发票 / 支付截图 / 手写记账本，认出来 → 整理成流水行 → 逐行核对 → 存进账本。

小程序（智能记账浮层的「拍一张」）和 H5（加号浮层、智能记账整页）都有这个入口，
走的是同一套接口，区别只在客户端怎么把图压下来。

链路分两步，**两步是两个不同的模型**，这点最容易踩：

```text
照片
  → 【第一步】图片识别（kind=ocr，OpenAI 兼容的 chat/completions + image_url data URL）
     作用：把版面文字全认出来，不做结构化
  → 纯文本
  → 【第二步】票据文本 → 流水行（kind=llm，与口语记账共用一套配置）
     作用：区分实付金额与余额、明细与合计，抽出日期 / 金额 / 方向 / 备注
  → 核对页（和语音记账同一套界面）
  → POST /api/v1/imports/commit
```

第一步只发图片、不发文字指令 —— 当前默认使用硅基流动上的 `deepseek-ai/DeepSeek-OCR`，
多补一句「请提取 JSON」反而会让它跑偏。结构化交给第二步的语言模型。
**换句话说：只配了 ocr 没配 llm，能认出字但整理不成流水**，界面会把识别出的原文直接摆出来让人照着手动记。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/ocr/status` | `{ available }`。免账本头（`LEDGER_OPTIONAL`），但仍需登录 |
| POST | `/api/v1/ocr/scan` | 认图，返回 `{ text, profile, chars }`。**两种送法都收**（见下） |
| POST | `/api/v1/imports/receipt` | 识别出的文本 → 流水行，与 `/imports/utterances` 同一条下游，只是提示词不同 |
| GET/PUT | `/api/v1/admin/ocr` | 图片识别配置列表。`items` 顺序即接力顺序，最多 8 套；密钥只回显掩码 |
| POST | `/api/v1/admin/ocr/test` | 测其中一套，不走接力，需上传图片，图片不保存 |

`/ocr/scan` 的两种送法进的是**同一个识别函数、同一套校验**：

- `multipart/form-data`，字段 `file` —— 直连用这条，图片不膨胀；
- `application/json`，`{ image_base64, mime }` —— 云通道只能走这条，因为
  `wx.cloud.callFunction` 的 event 只送 JSON。允许带 `data:*;base64,` 前缀，会先剥掉。

图片类型白名单：`jpeg / png / webp / bmp / heic`（客户端不给 mime 时按文件头嗅探）。
上限 6MB。

## AI 配置

管理后台 → 「图片识别」，默认预填硅基流动：

| 字段 | 值 |
|------|-----|
| `base_url` | `https://api.siliconflow.cn/v1`（带不带 `/v1`、给不给完整 endpoint 都会归一化） |
| `model` | `deepseek-ai/DeepSeek-OCR` |
| `api_key` | 只写不读，保存后仅回显掩码 |

和语音一样按 `sort_order` 接力：一套超时 / HTTP 失败 / 没认出文字，就换下一套。
全部失败时把每套的原因汇总返回（而不是只报最后一条），否则「都失败了」这种提示毫无排查价值。

## 客户端

| 位置 | 职责 |
|------|------|
| `miniprogram/utils/image.js` | 小程序端**唯一**允许调 `wx.chooseMedia` / `wx.compressImage` 的地方 |
| `miniprogram/utils/request.js` | `scanImage()` 按通道分流；`imageLimit()` 给出对应的体积上限 |
| `miniprogram/components/ai-panel/` | 小程序智能记账浮层：语音与拍照两条入口，共用核对与提交 |
| `web/src/photoSteps.ts` | H5 压图的**决策**（梯度、起始档位）。纯函数，拆出来是为了能单测 |
| `web/src/photo.ts` | H5 压图的**执行**（canvas 重绘），与小程序那份同构 |
| `web/src/components/ShotButton.vue` | H5 的相机入口（隐藏的 `input[type=file]`），两个 UI 处共用 |
| `web/src/voice.ts` | H5 共用逻辑：`checkPhoto()` / `pickPhoto()`，与语音汇到同一段核对 |
| `web/src/components/VoiceSheet.vue`、`web/src/pages/Speak.vue` | H5 的两个入口：加号浮层、智能记账整页 |

### 为什么压图必须集中在一处

手机直出的照片动辄 3–8MB，而后端上限 6MB、云通道的 event 上限约 1MB
（base64 还会把字节放大 1/3）。不压图的表现是**「开发者工具里好好的，体验版拍照必失败」**，
而且报错发生在服务端，很难联想到客户端没压。

体积上限跟着通道变：

| 通道 | 上限 | 依据 |
|------|------|------|
| 直连（开发者工具 / 真机调试） | 3MB | 后端 6MB，留一倍余量 |
| 云（体验版 / 正式版） | 600KB | event 1MB ÷ 4/3，再留余量 |

压缩梯度（`utils/image.js` 的 `STEPS`）是**先降质量、再降分辨率**：
小票上真正要读的是数字，先缩图会先把它糊掉。起始档位由 `startStep()` 这个纯函数决定
（按最坏情况估算，再往前让一档 —— 多压一轮只多花一两百毫秒，压过头是永久损失清晰度），
真机上再逐档压完核对实际体积收敛。

`check.mjs` 第 16 条会拦住绕开 `utils/image.js` 的写法（只覆盖小程序）。

### H5 那份的差别

H5 没有 `wx.compressImage`，只能自己 canvas 重绘。这份拆成两个文件：决策（梯度、起始档位）
在 `web/src/photoSteps.ts`，canvas 执行在 `web/src/photo.ts`。**拆开是为了能单测** ——
`test/` 是用根 tsconfig 跑的（lib 只有 ES2022、没有 DOM），直接 import 带 canvas 的模块
会让 `npm run typecheck` 直接红。梯度、起始档位算法、取舍完全照搬小程序那份，
**改一边就必须改另一边** —— `test/web-photo.test.ts` 有一条跨端一致性断言钉着
（scale 逐个相等、质量取整后相等）。

实现上有两处不得不不同：

- canvas 的输出固定是 jpeg，所以**不需要**按文件头猜 mime
  （`wx.compressImage` 的输出格式随机型变化，那份才要猜）；
- 画之前**必须先铺白底**：截图多半是 png，透明区转成 jpeg 会变黑，正好糊掉小票上的字。

体积上限取「直连」那一档（3MB）—— H5 走的是普通 `fetch`，没有云函数 event 的 1MB 限制。

H5 的选图还多一个坑：`input[type=file]` 选完**必须把 `value` 清空**，否则第二次选同一个文件
不会再触发 `change`，表现为「再点一次没反应」。这段集中在 `ShotButton.vue` 一处。

### 图片不留存

照片只在这一次请求的内存里过一遍：不写 D1，也不进对象存储。小程序那边临时文件交给微信回收，
H5 那边是内存里的 blob，用完交给 GC。需求上也不需要留存 —— 要留凭据的话，那应该是「收据」
那条链路（`POST /api/v1/transactions/:id/receipt`，见 `miniprogram/pages/tx-form`）。

## 相关代码

| 路径 | 职责 |
|------|------|
| `src/ocr/vision.ts` | 多套配置接力、端点归一化、版面标记清理、图片负载校验 |
| `src/routes/ocr.ts` | `/ocr/status`、`/ocr/scan`（两种送法）、后台测一套共用的读图 |
| `src/imports/ai.ts` | 两套系统提示词（口语 / 票据）与 `mode` 分支 |
| `src/routes/imports.ts` | `/imports/utterances`、`/imports/receipt` |
| `web/src/pages/admin/AdminOcr.vue` | 后台配置页 |
| `test/ocr.test.ts` | 后端：接力、两种送法、体积与类型守卫 |
| `test/web-photo.test.ts` | H5 压图的决策逻辑 + 与小程序的一致性 |
| `test/miniprogram-image.test.ts` | 小程序压图的决策逻辑 |

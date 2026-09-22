# 账单导入

把微信 / 支付宝 / 银行 / 自定义导出的账单转成账本流水。规则解析优先，AI 只在识别不出来时兜底。

## 支持的格式

| 来源 | 识别方式 | 说明 |
|------|----------|------|
| 微信支付账单 | 前导说明含「微信支付账单」或表头含「商品 / 支付方式 / 当前状态」 | 「收/支」列决定支出/收入，「不计收支」的行自动跳过 |
| 支付宝账单 | 前导说明含「支付宝」，或表头含「商品说明 / 收/付款方式 / 交易分类」 | 「交易分类」参与分类建议 |
| 银行流水 | 表头含「借贷 / 借方发生额 / 贷方发生额 / 摘要 / 对方户名」 | 支持「收入金额 / 支出金额」分列；余额列不会被误当金额 |
| 通用表格 | 表头有日期 + 金额列（列名任意） | 无表头时按取值特征推断日期 / 金额 / 方向 / 备注列 |
| JSON | 文件以 `{` / `[` 开头且能解析 | 对象数组、`{data:{list:[…]}}` 包装、NDJSON、数组的数组都支持 |
| AI 兜底 | 以上都识别不出，或规则命中率 < 50% | 需在管理后台配置 AI；没配就明确提示而不是瞎猜 |

文件格式支持 `.csv` `.tsv` `.txt` `.json` `.xlsx` `.xls` `.xlsm`。

### 为什么解码在浏览器做

微信 / 支付宝导出的 CSV 是 **GBK**，而 workerd 对 legacy 多字节编码（GBK / Big5）存在已知缺陷，`new TextDecoder('gbk')` 在 Worker 里不可靠。
因此：**CSV / JSON 在浏览器里嗅探编码（BOM → 严格 UTF-8 试解 → 回退 GBK）后上传 UTF-8 文本**；**Excel 由浏览器用 SheetJS 解析成二维表**上传。原始文件不出浏览器，Worker 侧零新增依赖。

## 解析流程

```text
文件 → 浏览器解码（GBK / xlsx）
     → 二维表
     → 找表头行（前 40 行里角色命中最多的一行）
     → 列映射：表头关键词优先，再用取值特征校验补位 / 剔除误判
     → 逐行归一化（日期、金额、方向、备注、对方）
     → 规则命中率不足 → AI 兜底（结果与规则结果按行号合并，规则优先）
     → 分类 / 账户建议（名称命中 → 关键词表 → 同方向第一个）
     → 疑似重复标记（账户 + 金额 + 发生时间 + 备注）
     → 预览返回（不落库）→ 用户修正 → 提交
```

取值容错：`¥1,234.56`、`(123.45)`、`123.45-`、全角数字、`35元`、`2024年1月2日`、`2024/1/2`、`20240102`、Excel 日期序列号、10/13 位时间戳都能解析。
**月日歧义写法（如 `01/02/2024`）直接判为失败行**，交给用户改，而不是猜错。

## 接口

用户接口需要 `Authorization: Bearer <jwt>` + `X-Ledger-Id`。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/imports/preview` | 解析预览，**不写库**。body：`{kind:'text',text}` 或 `{kind:'rows',rows}`，可带 `filename` / `sheet` / `use_ai`。不接收原始文件 |
| POST | `/api/v1/imports/utterances` | 自然语言预览，**不写库**。body：`{text}`。随礼/礼金会带上 `favor_*` |
| GET | `/api/v1/speech/status` | 是否已有可用语音配置 |
| POST | `/api/v1/speech/transcribe` | `multipart` 字段 `file`。只返回 `{text,profile}`，不保存音频 |
| POST | `/api/v1/imports/suggest` | AI 批量建议分类，body `{rows:[{i,note,counterparty,direction,amount_cents}]}` |
| POST | `/api/v1/imports/commit` | 提交落库，body `{source,filename,sheet,ai_used,dedupe,rows:[…]}`，返回 `{batch_id,imported,duplicates,skipped,failed}` |
| GET | `/api/v1/imports/batches` | 最近导入批次（`limit` 默认 20） |
| POST | `/api/v1/imports/batches/:id/undo` | 撤销该批次：删流水 + 回滚余额 |

管理端（管理员 JWT）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/admin/ai` | 读配置，`api_key` 只回显掩码 `key_hint` |
| PUT | `/api/v1/admin/ai` | 写配置；`api_key` 留空＝不改，`clear_key:true`＝清空；启用时三项必填 |
| POST | `/api/v1/admin/ai/test` | 连通性测试，可用表单里的临时参数 |
| GET/PUT | `/api/v1/admin/asr` | 语音配置列表。`items` 顺序即接力顺序，最多 8 套；密钥只回显掩码 |
| POST | `/api/v1/admin/asr/test` | 测其中一套，需上传音频，音频不保存 |

预览响应里的 `source` / `header_index` / `mapping` 会一并返回，方便排查「为什么这列没认出来」。

## AI 配置

管理后台 → 「AI 配置」tab，按 OpenAI 兼容协议配置：

- `base_url`：`https://api.deepseek.com/v1`（带不带 `/v1` 都会归一化成 `.../v1/chat/completions`，也可以直接填完整 endpoint）
- `api_key`：只写不读，保存后仅回显掩码
- `model`：如 `deepseek-chat`

只在两处调用模型：① 表格结构识别不出来时兜底转字段；② 用户点「AI 建议分类」或导入前需要建议时。
调用失败只降级、不阻断——规则解析的结果照常可用。

## 数据表

| 表 / 列 | 说明 |
|---------|------|
| `import_batches` | 批次台账：来源、文件名、行数统计、AI 标记、状态、操作人 |
| `transactions.import_batch_id` | 流水归属批次，为空表示手工录入；撤销按此列删除 |
| `ai_settings` | AI 配置，全局单行（`id='default'`） |
| `asr_profiles` | 语音识别配置，可多套。只存接口地址、模型和密钥，不存录音 |
| `gifts.import_batch_id` | 导入时认出的人情往来，随批次撤销 |

原始账单文件在浏览器里解析，服务端只收到文本或二维表，不保存文件正文。语音同样只在当次请求内存里转写，识别完即丢。批次表上的 `filename` 只是辨认用的文件名。

去重：**同账本 + 同账户 + 同金额 + 同发生时间 + 同备注** 视为重复，提交时跳过并计入 `duplicates`（`dedupe:false` 可关闭）。
撤销是物理删除 + 余额回滚，不保留流水快照，因此撤销后无法恢复。

## 限制

| 项 | 值 | 原因 |
|----|----|------|
| 单次文本 | 4MB | Worker 内存 / CPU |
| 解析总行数 | 20000 行 | 同上 |
| 预览返回 | 5000 行 | 响应体积；超出请在界面提示下拆分文件 |
| AI 处理 | 最多 200 行，每 50 行一次请求 | 成本与延迟 |
| 提交分批 | 每 25 行一个 `db.batch` | 一条流水 = 1 条 insert + 1~2 条余额更新，避开 D1 单批上限；任一批失败即回滚该批次 |

## 相关代码

| 路径 | 职责 |
|------|------|
| `web/src/importFile.ts` | 编码嗅探 + SheetJS 解析（浏览器侧） |
| `src/imports/values.ts` | 金额 / 日期 / 方向归一化（纯函数） |
| `src/imports/text.ts` | CSV / JSON → 二维表 |
| `src/imports/mapping.ts` | 表头识别、列映射、来源判定、单行归一化 |
| `src/imports/match.ts` | 分类 / 账户建议 |
| `src/imports/ai.ts` | OpenAI 兼容调用、AI 兜底解析与分类建议 |
| `src/imports/service.ts` | 预览 / 提交 / 去重 / 撤销编排 |
| `src/routes/imports.ts` | 导入路由 |

测试见 `test/imports.test.ts`（取值解析、结构识别、建议匹配、预览 / 提交 / 去重 / 撤销、管理端配置）。

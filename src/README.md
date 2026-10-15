# 后端模块结构

```text
src/
  node.ts                  # 进程入口（Sealos / 本地）
  app.ts                   # Hono 路由组装与鉴权中间件
  env.ts                   # 读取 .env
  money.ts / time.ts / http.ts  # 金额、时间、HTTP 错误
  auth/                    # 口令哈希、JWT、微信 code 换 openid 与绑定已有账号
  db/                      # SQLite 适配
  imports/                 # 账单导入：解析、建议、AI 兜底、提交与撤销
  speech/                  # 语音识别
  moderation/              # 本地违禁词检查（工具类，尚未接入业务），见 docs/moderation.md
  profiles.ts              # llm / asr 共用的模型配置读写
  calendar/                # 联系人阳历/农历、即将到来、年龄。见 docs/favors.md
  dicts.ts                 # 账本字典。日子标签和以后的同类配置都放这里
  routes/                  # 登录、账本、流水、预算、人情、导入、工具页交接、管理后台。人情规则见 docs/favors.md
  seed.ts                  # 注册时默认账户与分类
```

约定：

- 业务逻辑放在对应模块内，`routes/*.ts` 只做参数校验与编排
- 跨模块复用放到 `auth/`、`db/`、金额时间工具
- 静态前端源码在 `web/`，构建产物在 `public/`
- 数据库脚本在 `sql/`
- 账单导入的解析逻辑在 `imports/`，`routes/imports.ts` 只做参数校验与编排；契约见 `docs/import.md`

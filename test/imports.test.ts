import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { parseDelimited, textToTable, jsonToRows } from '../src/imports/text.ts'
import { detectTable, normalizeRow } from '../src/imports/mapping.ts'
import { parseAmountCents, parseDateYmd, parseDirection, excelSerialToYmd } from '../src/imports/values.ts'
import { suggestAccount, suggestCategory } from '../src/imports/match.ts'
import { extractJson, resolveEndpoint, withAiFailover, type AiConfig } from '../src/imports/ai.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({ db, jwtSecret: 'test-secret-test-secret', adminToken: 'admin-secret' })
  return { app, db }
}

async function json(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  const res = await app.request(path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, res }
}

function authHeaders(token: string, ledgerId: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'x-ledger-id': ledgerId, 'content-type': 'application/json' }
}

type Ctx = {
  token: string
  ledgerId: string
  accounts: { id: string; name: string }[]
  categories: { id: string; name: string; kind: 'expense' | 'income' }[]
}

async function newUser(app: ReturnType<typeof createApp>, username: string): Promise<Ctx> {
  const reg = await json(app, '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  })
  const { token, ledgers } = reg.body as { token: string; ledgers: { id: string }[] }
  const headers = authHeaders(token, ledgers[0].id)
  const accounts = (await json(app, '/api/v1/accounts', { headers })).body as { items: { id: string; name: string }[] }
  const categories = (await json(app, '/api/v1/categories', { headers })).body as {
    items: { id: string; name: string; kind: 'expense' | 'income' }[]
  }
  return { token, ledgerId: ledgers[0].id, accounts: accounts.items, categories: categories.items }
}

// ---------------------------------------------------------------------------
// 取值归一化
// ---------------------------------------------------------------------------

describe('导入取值解析', () => {
  it('金额：千分位、货币符号、括号负数、全角、Excel 数字', () => {
    expect(parseAmountCents('¥1,234.56')).toBe(123456)
    expect(parseAmountCents('１，２３４．５６')).toBe(123456)
    expect(parseAmountCents('(123.45)')).toBe(-12345)
    expect(parseAmountCents('123.45-')).toBe(-12345)
    expect(parseAmountCents('-12.3')).toBe(-1230)
    expect(parseAmountCents('35元')).toBe(3500)
    expect(parseAmountCents(35)).toBe(3500)
    expect(parseAmountCents('1,234')).toBe(123400)
    expect(parseAmountCents('0.00')).toBe(0)
    expect(parseAmountCents('')).toBeNull()
    expect(parseAmountCents('支付宝')).toBeNull()
    expect(parseAmountCents('待入账')).toBeNull()
  })

  it('日期：多种写法 + 序列号 + 时间戳，歧义写法不猜', () => {
    expect(parseDateYmd('2024-01-02')).toBe('2024-01-02')
    expect(parseDateYmd('2024/1/2')).toBe('2024-01-02')
    expect(parseDateYmd('2024.01.02')).toBe('2024-01-02')
    expect(parseDateYmd('2024年1月2日')).toBe('2024-01-02')
    expect(parseDateYmd('2024-01-02 12:30:00')).toBe('2024-01-02')
    expect(parseDateYmd('20240102')).toBe('2024-01-02')
    expect(parseDateYmd('2024-01-02T20:00:00Z')).toBe('2024-01-03')
    expect(parseDateYmd(excelSerialToYmd(45293)!)).toBe('2024-01-02')
    expect(parseDateYmd(45293)).toBe('2024-01-02')
    expect(parseDateYmd('2024-02-31')).toBeNull()
    expect(parseDateYmd('01/02/2024')).toBeNull()
    expect(parseDateYmd('')).toBeNull()
  })

  it('方向：收支、借贷、不计收支各有归属', () => {
    expect(parseDirection('支出')).toBe('expense')
    expect(parseDirection('借')).toBe('expense')
    expect(parseDirection('借方')).toBe('expense')
    expect(parseDirection('收入')).toBe('income')
    expect(parseDirection('贷方')).toBe('income')
    expect(parseDirection('不计收支')).toBe('skip')
    expect(parseDirection('/')).toBe('skip')
    expect(parseDirection('pending')).toBeNull()
    expect(parseDirection('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 表格解析
// ---------------------------------------------------------------------------

describe('CSV / JSON → 二维表', () => {
  it('引号内逗号、换行、双写引号、CRLF、BOM 都能处理', () => {
    const csv = '\uFEFFa,b,c\r\n1,"x,y",3\r\n2,"line1\nline2",4\r\n5,"say ""hi""",6\r\n'
    const { rows } = parseDelimited(csv)
    expect(rows[0]).toEqual(['a', 'b', 'c'])
    expect(rows[1][1]).toBe('x,y')
    expect(rows[2][1]).toBe('line1\nline2')
    expect(rows[3][1]).toBe('say "hi"')
  })

  it('自动嗅探制表符与分号分隔', () => {
    expect(parseDelimited('a\tb\tc\n1\t2\t3').delimiter).toBe('\t')
    expect(parseDelimited('a;b;c\n1;2;3').delimiter).toBe(';')
  })

  it('JSON：对象数组、包装对象、NDJSON、数组的数组', () => {
    expect(jsonToRows('[{"a":1,"b":"x"}]')).toEqual([['a', 'b'], ['1', 'x']])
    expect(jsonToRows('{"data":{"list":[{"a":1}]}}')).toEqual([['a'], ['1']])
    expect(jsonToRows('{"a":1}\n{"a":2}')).toEqual([['a'], ['1'], ['2']])
    expect(jsonToRows('[[\"a\",\"b\"],[1,2]]')).toEqual([['a', 'b'], ['1', '2']])
    expect(jsonToRows('不是 json')).toBeNull()
  })

  it('textToTable 会按内容选择 CSV 或 JSON 通道', () => {
    expect(textToTable('[{"a":1}]')?.via).toBe('json')
    expect(textToTable('a,b\n1,2')?.via).toBe('csv')
  })
})

describe('表格结构识别', () => {
  it('微信账单：跳过前导说明行，认到「收/支」「金额(元)」', () => {
    const text = [
      '微信支付账单明细,,,,,,,,',
      '微信昵称：[张三],,,,,,,,',
      '起始时间：[2024-01-01 00:00:00],,,,,,,,',
      '----------------------微信支付账单明细列表--------------------,,,,,,,,',
      '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
      '2024-01-02 12:30:00,商户消费,某餐厅,午餐,支出,¥35.00,零钱,支付成功,4200001234,10001,/',
      '2024-01-03 09:00:00,转账,张三,转账,不计收支,¥100.00,零钱,已到账,4200001235,10002,/',
      '2024-01-05 18:00:00,微信红包,李四,红包,收入,¥20.00,零钱,已存入零钱,4200001236,10003,/',
    ].join('\n')
    const table = textToTable(text)!
    const shape = detectTable(table.rows, table.via)!
    expect(shape.source).toBe('wechat')
    expect(shape.headerIndex).toBe(4)

    const rows = table.rows.slice(shape.headerIndex + 1).map((r, i) => normalizeRow(r, shape, shape.headerIndex + 2 + i))
    expect(rows[0].status).toBe('ok')
    expect(rows[0]).toMatchObject({ date: '2024-01-02', amount_cents: 3500, direction: 'expense', note: '午餐', counterparty: '某餐厅' })
    expect(rows[1].status).toBe('skip')
    expect(rows[2]).toMatchObject({ amount_cents: 2000, direction: 'income' })
  })

  it('支付宝账单：识别交易分类与收/付款方式', () => {
    const text = [
      '支付宝交易记录明细查询',
      '账号:[zhang@example.com]',
      '---------------------------------交易记录明细列表------------------------------------',
      '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
      '2024-01-06 10:00:00,餐饮美食,某某餐厅,rest***@x.com,午餐,支出,35.00,余额宝,交易成功,20240106001,1001,',
      '2024-01-07 11:00:00,转账红包,李四,lisi@x.com,红包,收入,66.00,账户余额,交易成功,20240107001,1002,',
    ].join('\n')
    const table = textToTable(text)!
    const shape = detectTable(table.rows, table.via)!
    expect(shape.source).toBe('alipay')
    expect(shape.map.account).toBe(7)
    const row = normalizeRow(table.rows[shape.headerIndex + 1], shape, shape.headerIndex + 2)
    expect(row).toMatchObject({ amount_cents: 3500, direction: 'expense', account_name: '余额宝', category_name: '餐饮美食' })
  })

  it('银行流水：借贷分列 + 余额列不参与金额识别', () => {
    const text = [
      '交易日期,摘要,对方户名,借方发生额,贷方发生额,余额',
      '2024-01-08,消费,某超市,120.50,,10000.00',
      '2024-01-09,代发工资,某公司,,8000.00,18000.00',
    ].join('\n')
    const table = textToTable(text)!
    const shape = detectTable(table.rows, table.via)!
    expect(shape.source).toBe('bank')
    expect(shape.map.expense_amount).toBe(3)
    expect(shape.map.income_amount).toBe(4)
    const out = normalizeRow(table.rows[1], shape, 2)
    expect(out).toMatchObject({ amount_cents: 12050, direction: 'expense', note: '消费', counterparty: '某超市' })
    const inc = normalizeRow(table.rows[2], shape, 3)
    expect(inc).toMatchObject({ amount_cents: 800000, direction: 'income' })
  })

  it('无表头 CSV：按取值特征推断日期/金额/备注列', () => {
    const table = textToTable('2024-01-10,-35.00,午饭\n2024-01-11,120.00,红包\n')!
    const shape = detectTable(table.rows, table.via)!
    expect(shape.headerIndex).toBe(-1)
    expect(shape.map.date).toBe(0)
    expect(shape.map.amount).toBe(1)
    expect(shape.map.note).toBe(2)
    const out = normalizeRow(table.rows[0], shape, 1)
    expect(out).toMatchObject({ date: '2024-01-10', amount_cents: 3500, direction: 'expense', note: '午饭' })
  })

  it('识别不了结构时返回 null，不硬猜', () => {
    const table = textToTable('随便一些文字\n没有任何表格结构')!
    expect(detectTable(table.rows, table.via)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 分类 / 账户建议
// ---------------------------------------------------------------------------

describe('分类与账户建议', () => {
  const categories = [
    { id: 'c1', name: '餐饮', kind: 'expense' as const },
    { id: 'c2', name: '交通', kind: 'expense' as const },
    { id: 'c3', name: '工资', kind: 'income' as const },
  ]
  const accounts = [
    { id: 'a1', name: '现金' },
    { id: 'a2', name: '微信' },
    { id: 'a3', name: '支付宝' },
  ]

  it('关键词命中分类', () => {
    expect(suggestCategory('expense', '美团外卖 午餐', categories)?.name).toBe('餐饮')
    expect(suggestCategory('expense', '滴滴出行', categories)?.name).toBe('交通')
    expect(suggestCategory('income', '6月工资', categories)?.name).toBe('工资')
  })

  it('没命中关键词时落到同方向第一个分类', () => {
    expect(suggestCategory('expense', '说不清的东西', categories)?.name).toBe('餐饮')
  })

  it('账户按名称与银行关键词匹配', () => {
    expect(suggestAccount('零钱', accounts)?.name).toBe('微信')
    expect(suggestAccount('余额宝', accounts)?.name).toBe('支付宝')
    expect(suggestAccount('现金支付', accounts)?.name).toBe('现金')
    // 关键词命中「银行卡」但账本里没有该账户时返回 null，由调用方决定兜底
    expect(suggestAccount('招商银行储蓄卡', accounts)).toBeNull()
    expect(suggestAccount('招商银行储蓄卡', [...accounts, { id: 'a4', name: '银行卡' }])?.name).toBe('银行卡')
  })
})

describe('AI 工具函数', () => {
  it('base_url 归一化', () => {
    expect(resolveEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(resolveEndpoint('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(resolveEndpoint('https://x.com/v1/chat/completions')).toBe('https://x.com/v1/chat/completions')
  })

  it('从模型输出里提取 JSON（含围栏与前后废话）', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true })
    expect(extractJson('```json\n{"rows":[]}\n```')).toEqual({ rows: [] })
    expect(extractJson('好的，结果如下：{"rows":[{"a":1}]} 以上。')).toEqual({ rows: [{ a: 1 }] })
    expect(extractJson('没有 json')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

const WECHAT_CSV = [
  '微信支付账单明细,,,,,,,,',
  '微信昵称：[张三],,,,,,,,',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2024-01-02 12:30:00,商户消费,某餐厅,午餐,支出,¥35.00,零钱,支付成功,4200001234,10001,/',
  '2024-01-03 09:00:00,转账,张三,转账,不计收支,¥100.00,零钱,已到账,4200001235,10002,/',
  '2024-01-05 18:00:00,微信红包,李四,红包,收入,¥20.00,零钱,已存入零钱,4200001236,10003,/',
].join('\n')

describe('导入接口', () => {
  it('预览：微信 CSV 给出分类/账户建议且不落库', async () => {
    const { app, db } = await setup()
    const ctx = await newUser(app, 'importer1')
    const res = await json(app, '/api/v1/imports/preview', {
      method: 'POST',
      headers: authHeaders(ctx.token, ctx.ledgerId),
      body: JSON.stringify({ kind: 'text', text: WECHAT_CSV, filename: '微信账单.csv' }),
    })
    expect(res.status).toBe(200)
    const body = res.body as {
      source: string
      stats: { total: number; ok: number; skip: number; failed: number }
      ai: { available: boolean; used: boolean }
      rows: { row: number; direction: string; amount_cents: number; category_name: string; account_name: string; status: string }[]
    }
    expect(body.source).toBe('wechat')
    expect(body.stats).toMatchObject({ total: 3, ok: 2, skip: 1, failed: 0 })
    expect(body.ai.used).toBe(false)
    expect(body.ai.available).toBe(false)

    const lunch = body.rows.find((r) => r.amount_cents === 3500)!
    expect(lunch.status).toBe('ok')
    expect(lunch.account_name).toBe('微信')
    expect(lunch.category_name).toBe('餐饮')
    const gift = body.rows.find((r) => r.direction === 'income')!
    expect(gift.category_name).toBe('红包')

    const count = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions`)
    expect(Number(count?.n)).toBe(0)
  })

  it('预览：Excel 二维表（前端 SheetJS 转换结果）与 JSON 都能导入', async () => {
    const { app } = await setup()
    const ctx = await newUser(app, 'importer2')
    const headers = authHeaders(ctx.token, ctx.ledgerId)

    const rows = (await json(app, '/api/v1/imports/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'rows',
        sheet: 'Sheet1',
        rows: [
          ['交易时间', '收/支', '金额(元)', '备注'],
          ['2024-01-14', '支出', '12.5', '饮料'],
          ['2024-01-15', '收入', '500', '奖金'],
        ],
      }),
    })).body as { sheet?: string; stats: { ok: number }; rows: { note: string; direction: string }[] }
    expect(rows.sheet).toBe('Sheet1')
    expect(rows.stats.ok).toBe(2)
    expect(rows.rows[0]).toMatchObject({ note: '饮料', direction: 'expense' })

    const jsonBody = (await json(app, '/api/v1/imports/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'text',
        text: JSON.stringify([
          { 交易时间: '2024-01-16', 金额: '-88.80', 备注: '打车' },
          { 交易时间: '2024-01-17', 金额: '300.00', 备注: '红包' },
        ]),
      }),
    })).body as { source: string; stats: { ok: number }; rows: { direction: string; note: string }[] }
    expect(jsonBody.source).toBe('json')
    expect(jsonBody.stats.ok).toBe(2)
    expect(jsonBody.rows[0]).toMatchObject({ direction: 'expense', note: '打车' })
    expect(jsonBody.rows[1].direction).toBe('income')
  })

  it('预览：结构识别不出来且未配置 AI 时明确报错', async () => {
    const { app } = await setup()
    const ctx = await newUser(app, 'importer3')
    const body = (await json(app, '/api/v1/imports/preview', {
      method: 'POST',
      headers: authHeaders(ctx.token, ctx.ledgerId),
      body: JSON.stringify({ kind: 'text', text: '随便一些文字\n没有任何表格结构' }),
    })).body as { ai: { available: boolean; error?: string }; stats: { failed: number } }
    expect(body.ai.available).toBe(false)
    expect(body.ai.error).toBeTruthy()
    expect(body.stats.failed).toBeGreaterThan(0)
  })

  it('提交：写库、余额正确、去重生效', async () => {
    const { app } = await setup()
    const ctx = await newUser(app, 'importer4')
    const headers = authHeaders(ctx.token, ctx.ledgerId)
    const preview = (await json(app, '/api/v1/imports/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'text', text: WECHAT_CSV }),
    })).body as { rows: { row: number; status: string; date: string; amount_cents: number; direction: string; note: string; category_id: string; account_id: string }[] }

    const rows = preview.rows.map((r) => ({
      date: r.date,
      amount_cents: r.amount_cents,
      direction: r.direction,
      note: r.note,
      category_id: r.category_id,
      account_id: r.account_id,
    }))

    const created = await json(app, '/api/v1/imports/commit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'wechat', filename: '微信账单.csv', rows, ai_used: false }),
    })
    expect(created.status).toBe(201)
    const result = created.body as { batch_id: string; imported: number; duplicates: number; skipped: number; failed: unknown[] }
    expect(result).toMatchObject({ imported: 2, duplicates: 0, skipped: 1 })

    // 支出 35，收入 20 → 微信账户余额 -15
    const accounts = (await json(app, '/api/v1/accounts', { headers })).body as { items: { name: string; current_cents: number }[] }
    expect(accounts.items.find((a) => a.name === '微信')?.current_cents).toBe(-1500)

    // 再导入一次：同账户+金额+日期+备注 视为重复
    const again = await json(app, '/api/v1/imports/commit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'wechat', rows }),
    })
    expect(again.body as { imported: number; duplicates: number }).toMatchObject({ imported: 0, duplicates: 2 })

    const batches = (await json(app, '/api/v1/imports/batches', { headers })).body as {
      items: { id: string; imported_rows: number; duplicate_rows: number; status: string }[]
    }
    expect(batches.items.length).toBe(2)
    expect(batches.items[1]).toMatchObject({ imported_rows: 2, duplicate_rows: 0, status: 'done' })
  })

  it('提交：账户/分类归属与方向不匹配时逐行报错，不写脏数据', async () => {
    const { app, db } = await setup()
    const ctx = await newUser(app, 'importer5')
    const headers = authHeaders(ctx.token, ctx.ledgerId)
    const incomeCat = ctx.categories.find((c) => c.kind === 'income')!
    const expenseCat = ctx.categories.find((c) => c.kind === 'expense')!

    const res = await json(app, '/api/v1/imports/commit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'generic',
        rows: [
          { date: '2024-01-02', amount_cents: 1000, direction: 'expense', category_id: incomeCat.id, account_id: ctx.accounts[0].id, note: '方向不符' },
          { date: '2024-01-02', amount_cents: 1000, direction: 'expense', category_id: 'not-exist', account_id: ctx.accounts[0].id, note: '分类不存在' },
          { date: '2024-02-31', amount_cents: 1000, direction: 'expense', category_id: expenseCat.id, account_id: ctx.accounts[0].id, note: '非法日期' },
          { date: '2024-01-02', amount_cents: 0, direction: 'expense', category_id: expenseCat.id, account_id: ctx.accounts[0].id, note: '零金额' },
          { date: '2024-01-02', amount_cents: 1000, direction: 'expense', category_id: expenseCat.id, account_id: ctx.accounts[0].id, note: '正常' },
        ],
      }),
    })
    const result = res.body as { imported: number; failed: { reason: string }[] }
    expect(result.imported).toBe(1)
    expect(result.failed.map((f) => f.reason)).toEqual(['分类与收支方向不一致', '分类不存在', '日期无效', '金额无效'])
    const count = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions`)
    expect(Number(count?.n)).toBe(1)
  })

  it('撤销：删除该批次流水并回滚余额，重复撤销报错', async () => {
    const { app } = await setup()
    const ctx = await newUser(app, 'importer6')
    const headers = authHeaders(ctx.token, ctx.ledgerId)
    const expenseCat = ctx.categories.find((c) => c.kind === 'expense')!
    const account = ctx.accounts[0]

    const created = (await json(app, '/api/v1/imports/commit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'generic',
        rows: [
          { date: '2024-01-02', amount_cents: 1234, direction: 'expense', category_id: expenseCat.id, account_id: account.id, note: 'a' },
          { date: '2024-01-03', amount_cents: 500, direction: 'expense', category_id: expenseCat.id, account_id: account.id, note: 'b' },
        ],
      }),
    })).body as { batch_id: string }

    const before = (await json(app, '/api/v1/accounts', { headers })).body as { items: { id: string; current_cents: number }[] }
    expect(before.items.find((a) => a.id === account.id)?.current_cents).toBe(-1734)

    const undone = await json(app, `/api/v1/imports/batches/${created.batch_id}/undo`, { method: 'POST', headers })
    expect(undone.status).toBe(200)
    expect(undone.body as { removed: number }).toMatchObject({ removed: 2 })

    const after = (await json(app, '/api/v1/accounts', { headers })).body as { items: { id: string; current_cents: number }[] }
    expect(after.items.find((a) => a.id === account.id)?.current_cents).toBe(0)

    const again = await json(app, `/api/v1/imports/batches/${created.batch_id}/undo`, { method: 'POST', headers })
    expect(again.status).toBe(400)
  })

  it('AI 建议分类：未配置时返回可读错误而不是 500', async () => {
    const { app } = await setup()
    const ctx = await newUser(app, 'importer7')
    const res = await json(app, '/api/v1/imports/suggest', {
      method: 'POST',
      headers: authHeaders(ctx.token, ctx.ledgerId),
      body: JSON.stringify({ rows: [{ i: 0, note: '午饭', direction: 'expense', amount_cents: 3500 }] }),
    })
    expect(res.status).toBe(200)
    expect(res.body as { error?: string }).toMatchObject({ error: 'AI 未启用' })
  })

  it('管理端 AI 配置：api_key 只回显掩码，启用时必须填全', async () => {
    const { app } = await setup()
    const login = await json(app, '/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
    const adminToken = (login.body as { token: string }).token
    const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }

    const empty = await json(app, '/api/v1/admin/ai', { headers: adminHeaders })
    expect(empty.body).toMatchObject({ items: [] })

    const bad = await json(app, '/api/v1/admin/ai', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ items: [{ enabled: true, base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }] }),
    })
    expect(bad.status).toBe(400)

    const saved = await json(app, '/api/v1/admin/ai', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        items: [
          { name: '主', enabled: true, base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: 'sk-test-1234567890' },
          { name: '备', enabled: true, base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', api_key: 'sk-backup-1234567890' },
        ],
      }),
    })
    expect(saved.status).toBe(200)
    const items = (saved.body as { items: { id: string; name: string; enabled: boolean; has_key: boolean; key_hint: string; endpoint: string; sort_order: number }[] }).items
    expect(items.map((item) => item.name)).toEqual(['主', '备'])
    expect(items[0].sort_order).toBe(0)
    expect(items[1].sort_order).toBe(1)
    expect(items[0].key_hint).toBe('sk-t****7890')
    expect(items[0].endpoint).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(JSON.stringify(saved.body)).not.toContain('sk-test-1234567890')
    expect(JSON.stringify(saved.body)).not.toContain('sk-backup-1234567890')

    // 留空 api_key 表示不改；clear_key 才清空。顺序可以调整。
    await json(app, '/api/v1/admin/ai', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        items: [
          { id: items[1].id, name: '备', enabled: true, base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', api_key: '' },
          { id: items[0].id, name: '主', enabled: false, base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', clear_key: true },
        ],
      }),
    })
    const again = (await json(app, '/api/v1/admin/ai', { headers: adminHeaders })).body as {
      items: { name: string; has_key: boolean; enabled: boolean }[]
    }
    expect(again.items.map((item) => item.name)).toEqual(['备', '主'])
    expect(again.items[0]).toMatchObject({ has_key: true, enabled: true })
    expect(again.items[1]).toMatchObject({ has_key: false, enabled: false })
  })

  it('导入接口需要账本上下文，未带 X-Ledger-Id 时拒绝', async () => {
    const { app } = await setup()
    const ctx = await newUser(app, 'importer8')
    const res = await json(app, '/api/v1/imports/preview', {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'text', text: WECHAT_CSV }),
    })
    expect(res.status).toBe(401)
  })
})

describe('AI 失败换下一套', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  function cfg(name: string, model: string, enabled = true): AiConfig {
    return {
      id: name,
      name,
      enabled,
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model,
      sortOrder: 0,
    }
  }

  it('第一套报错或返回坏 JSON 时改用下一套，停用的跳过', async () => {
    const called: string[] = []
    globalThis.fetch = async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model as string
      called.push(model)
      if (model === 'bad') return new Response('nope', { status: 500 })
      if (model === 'junk') {
        return new Response(JSON.stringify({ choices: [{ message: { content: '不是 JSON' } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"rows":[]}' } }] }), { status: 200 })
    }
    const res = await withAiFailover([cfg('主', 'bad'), cfg('停', 'skip', false), cfg('备', 'good')], async (item) => {
      const chatRes = await fetch('https://example.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: item.model }),
      })
      if (!chatRes.ok) return { ok: false as const, error: `HTTP ${chatRes.status}` }
      const payload = (await chatRes.json()) as { choices: { message: { content: string } }[] }
      const text = payload.choices[0].message.content
      if (!text.includes('rows')) return { ok: false as const, error: 'AI 输出格式不符合预期' }
      return { ok: true as const, data: text }
    })
    expect(res).toMatchObject({ ok: true, data: '{"rows":[]}' })
    expect(called).toEqual(['bad', 'good'])
  })
})

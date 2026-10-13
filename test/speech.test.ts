import { describe, expect, it, afterEach } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { detectFavor, parseUtterances } from '../src/imports/favor.ts'
import { transcribeChain, type AsrProfile } from '../src/speech/asr.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({
    db,
    jwtSecret: 'test-secret-test-secret',
    adminToken: 'admin-secret',
    exchangeWechatCode: async (code) => ({ openid: `speech-${code}`, unionid: null }),
  })
  return { app, db }
}

/** 语音和文本整理只对微信用户开放，这两条用例走微信登录。 */
async function wechatSession(app: ReturnType<typeof createApp>, code: string) {
  const login = await json(app, '/api/v1/auth/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const body = login.body as { token: string; ledgers: { id: string }[] }
  return {
    headers: {
      authorization: `Bearer ${body.token}`,
      'x-ledger-id': body.ledgers[0].id,
      'content-type': 'application/json',
    },
  }
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
  return { status: res.status, body }
}

describe('人情往来识别', () => {
  it('随礼和礼金能认出对方、方向和事由', () => {
    expect(detectFavor('昨天给张三结婚随了500')).toMatchObject({
      contactName: '张三',
      giftKind: 'give',
      occasion: '结婚',
    })
    expect(detectFavor('收到李四礼金200元', 'income')).toMatchObject({
      contactName: '李四',
      giftKind: 'receive',
      occasion: '',
    })
    expect(detectFavor('美团红包 3.5')).toBeNull()
    expect(detectFavor('给张三转了500')).toMatchObject({ contactName: '张三', giftKind: 'give' })
    expect(detectFavor('收到工资8000')).toBeNull()
  })

  it('自然语言按句拆开，没金额或没姓名的不入账', () => {
    const rows = parseUtterances('给张三结婚随了500。午饭 35。随礼一下')
    expect(rows[0]).toMatchObject({ kind: 'entry', direction: 'expense', amountCents: 50000, favor: { contactName: '张三' } })
    expect(rows[1]).toMatchObject({ kind: 'entry', direction: 'expense', amountCents: 3500, favor: null })
    expect(rows[2]).toMatchObject({ kind: 'skip', reason: '像人情往来，但没认出对方姓名' })
  })
})

describe('语音识别多套接力', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  function profile(partial: Partial<AsrProfile> & Pick<AsrProfile, 'id' | 'model'>): AsrProfile {
    return {
      name: String(partial.id),
      enabled: true,
      protocol: 'openai-audio',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'sk-test',
      sortOrder: 0,
      updatedAt: 0,
      ...partial,
    }
  }

  it('第一套失败才用下一套，停用的不参与', async () => {
    const called: string[] = []
    globalThis.fetch = async (_url, init) => {
      const model = String(init?.body && (init.body as FormData).get('model'))
      called.push(model)
      if (model === 'bad') return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ text: '给张三随了500' }), { status: 200 })
    }
    const res = await transcribeChain(
      [
        profile({ id: 1, model: 'bad', sortOrder: 0 }),
        profile({ id: 2, model: 'skip', enabled: false, sortOrder: 1 }),
        profile({ id: 3, model: 'XingChenAGI/XingChenASR-V3.2-Ultra', sortOrder: 2 }),
      ],
      { bytes: new Uint8Array([1, 2, 3]), filename: 'a.webm', mime: 'audio/webm' },
    )
    expect(res).toMatchObject({ ok: true, text: '给张三随了500', profile: '3' })
    expect(called).toEqual(['bad', 'XingChenAGI/XingChenASR-V3.2-Ultra'])
  })

  it('管理端按顺序保存多套，密钥只回显掩码', async () => {
    const { app, db } = await setup()
    const login = await json(app, '/api/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-secret' }),
    })
    const headers = { authorization: `Bearer ${(login.body as { token: string }).token}`, 'content-type': 'application/json' }
    const saved = await json(app, '/api/v1/admin/asr', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        items: [
          { name: '主', enabled: true, base_url: 'https://api.siliconflow.cn/v1', model: 'XingChenAGI/XingChenASR-V3.2-Ultra', api_key: 'sk-primary-1234567890' },
          { name: '备', enabled: true, base_url: 'https://api.example.com/v1', model: 'backup-asr', api_key: 'sk-backup-1234567890' },
        ],
      }),
    })
    expect(saved.status).toBe(200)
    const items = (saved.body as { items: { name: string; sort_order: number; key_hint: string; endpoint: string }[] }).items
    expect(items.map((item) => item.name)).toEqual(['主', '备'])
    expect(items[0].sort_order).toBe(0)
    expect(items[1].sort_order).toBe(1)
    expect(items[0].key_hint).toBe('sk-p****7890')
    expect(items[0].endpoint).toBe('https://api.siliconflow.cn/v1/audio/transcriptions')
    expect(JSON.stringify(saved.body)).not.toContain('sk-primary')
    expect(JSON.stringify(saved.body)).not.toContain('sk-backup')

    const rows = await db.all<{ name: string }>(`SELECT name FROM ai_profiles WHERE kind = 'asr' ORDER BY sort_order`)
    expect(rows.map((row) => row.name)).toEqual(['主', '备'])
  })
})

describe('自然语言入账', () => {
  it('随礼同时记流水和人情，原文与录音都不入库', async () => {
    const { app, db } = await setup()
    const { headers } = await wechatSession(app, 'speaker')
    const preview = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '给张三结婚随了500' }),
    })
    const item = (preview.body as { items: { status: string; favor_contact: string; favor_kind: string; favor_occasion: string; category_id: string; account_id: string; amount_cents: number; date: string; direction: string; note: string }[] }).items[0]
    expect(item.favor_contact).toBe('张三')
    expect(item.favor_kind).toBe('give')
    expect(item.favor_occasion).toBe('结婚')
    expect(preview.body).toMatchObject({ parser: 'rules', ai_error: '' })
    const created = await json(app, '/api/v1/imports/commit', {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'utterance', filename: '', rows: [item] }),
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ imported: 1, gifts: 1 })
    const gifts = await db.all<{ name: string; occasion: string }>('SELECT c.name AS name, g.occasion AS occasion FROM gifts g JOIN contacts c ON c.id = g.contact_id')
    expect(gifts).toEqual([{ name: '张三', occasion: '结婚' }])
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    expect(tables.map((row) => row.name)).not.toContain('speech_audio')
    expect(tables.map((row) => row.name)).not.toContain('import_files')
  })

  it('智能记账的人情行可以不记明细', async () => {
    const { app, db } = await setup()
    const { headers } = await wechatSession(app, 'favor-only')
    const accounts = await json(app, '/api/v1/accounts', { headers })
    const accountId = (accounts.body as { items: { id: number }[] }).items[0].id
    const created = await json(app, '/api/v1/imports/commit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'utterance',
        rows: [
          {
            date: '2026-10-02',
            amount_cents: 50000,
            direction: 'expense',
            note: '随礼',
            favor_contact: '张三',
            favor_kind: 'give',
            favor_occasion: '结婚',
            also_tx: false,
          },
        ],
      }),
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ imported: 0, gifts: 1 })
    expect(await db.first(`SELECT COUNT(*) AS n FROM transactions`)).toEqual({ n: 0 })
    expect(await db.first(`SELECT current_cents AS n FROM accounts WHERE id = ?`, [accountId])).toEqual({ n: 0 })
    expect(await db.first(`SELECT c.name AS name FROM gifts g JOIN contacts c ON c.id = g.contact_id`)).toEqual({
      name: '张三',
    })
  })

  it('配置了 AI 时用模型结果，模型失败则退回规则', async () => {
    const original = globalThis.fetch
    const { app, db } = await setup()
    const { headers } = await wechatSession(app, 'speakerai')
    await db.run(
      `INSERT INTO ai_profiles (kind, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
       VALUES ('llm', '测', 1, '', 'https://example.com/v1', 'sk-test', 'demo', 0, 1)`,
    )
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      date: '2026-09-22',
                      amount: 35,
                      direction: 'expense',
                      note: '午饭',
                      category: '餐饮',
                      account: '',
                      source: '午饭35',
                      favor_contact: '',
                      favor_kind: '',
                      favor_occasion: '',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )
    const ok = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '午饭35' }),
    })
    expect(ok.body).toMatchObject({ parser: 'ai', ai_error: '' })
    expect((ok.body as { items: { note: string; amount_cents: number }[] }).items[0]).toMatchObject({
      note: '午饭',
      amount_cents: 3500,
    })

    globalThis.fetch = async () => new Response('nope', { status: 500 })
    const fallback = await json(app, '/api/v1/imports/utterances', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '给张三结婚随了500' }),
    })
    expect(fallback.body).toMatchObject({ parser: 'rules' })
    expect((fallback.body as { items: { favor_contact: string }[] }).items[0].favor_contact).toBe('张三')
    expect((fallback.body as { ai_error: string }).ai_error).toContain('500')
    globalThis.fetch = original
  })
})

describe('人情和明细互相转换', () => {
  it('记人情时可以同时记一笔明细，余额只动明细', async () => {
    const { app, db } = await setup()
    const { headers } = await wechatSession(app, 'also-tx')
    const accounts = await json(app, '/api/v1/accounts', { headers })
    const categories = await json(app, '/api/v1/categories', { headers })
    const accountId = (accounts.body as { items: { id: number }[] }).items[0].id
    const expenseId = (categories.body as { items: { id: number; kind: string }[] }).items.find((c) => c.kind === 'expense')!.id
    const incomeId = (categories.body as { items: { id: number; kind: string }[] }).items.find((c) => c.kind === 'income')!.id
    const contact = await json(app, '/api/v1/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '李四', relation: '' }),
    })
    const contactId = (contact.body as { id: number }).id
    const gift = {
      contact_id: contactId,
      kind: 'give',
      amount_cents: 20000,
      date: '2026-10-02',
      occasion: '生日',
      note: '',
    }

    const plain = await json(app, '/api/v1/gifts', { method: 'POST', headers, body: JSON.stringify(gift) })
    expect(plain.status).toBe(201)
    expect(plain.body).not.toHaveProperty('transaction_id')
    expect(await db.first(`SELECT COUNT(*) AS n FROM transactions`)).toEqual({ n: 0 })
    expect(await db.first(`SELECT current_cents AS n FROM accounts WHERE id = ?`, [accountId])).toEqual({ n: 0 })

    const both = await json(app, '/api/v1/gifts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...gift, account_id: accountId, category_id: expenseId }),
    })
    expect(both.status).toBe(201)
    expect(both.body).toMatchObject({ contact_name: '李四', kind: 'give' })
    expect((both.body as { transaction_id: number }).transaction_id).toEqual(expect.any(Number))
    expect(await db.first(`SELECT COUNT(*) AS n FROM gifts`)).toEqual({ n: 2 })
    expect(await db.first(`SELECT kind, amount_cents, note, category_id FROM transactions`)).toEqual({
      kind: 'expense',
      amount_cents: 20000,
      note: '李四',
      category_id: expenseId,
    })
    expect(await db.first(`SELECT current_cents AS n FROM accounts WHERE id = ?`, [accountId])).toEqual({ n: -20000 })

    const mismatch = await json(app, '/api/v1/gifts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...gift, account_id: accountId, category_id: incomeId }),
    })
    expect(mismatch.status).toBe(400)

    const half = await json(app, '/api/v1/gifts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...gift, account_id: accountId }),
    })
    expect(half.status).toBe(400)
  })

  it('流水转成人情后可以再转回明细，余额跟着走', async () => {
    const { app, db } = await setup()
    const { headers } = await wechatSession(app, 'convert')
    const accounts = await json(app, '/api/v1/accounts', { headers })
    const categories = await json(app, '/api/v1/categories', { headers })
    const accountId = (accounts.body as { items: { id: number; name: string }[] }).items[0].id
    const categoryId = (categories.body as { items: { id: number; kind: string }[] }).items.find((c) => c.kind === 'expense')!.id
    const contact = await json(app, '/api/v1/contacts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '张三', relation: '同事' }),
    })
    const contactId = (contact.body as { id: number }).id
    const created = await json(app, '/api/v1/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 80000,
        date: '2026-10-01',
        account_id: accountId,
        category_id: categoryId,
        note: '随礼',
      }),
    })
    const txId = (created.body as { id: number }).id
    expect(await db.first(`SELECT current_cents AS n FROM accounts WHERE id = ?`, [accountId])).toEqual({ n: -80000 })

    const toGift = await json(app, `/api/v1/transactions/${txId}/to-gift`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contact_id: contactId, kind: 'give', amount_cents: 80000, date: '2026-10-01', occasion: '结婚', note: '随礼' }),
    })
    expect(toGift.status).toBe(201)
    expect(toGift.body).toMatchObject({ contact_name: '张三', kind: 'give', occasion: '结婚' })
    expect(await db.first(`SELECT COUNT(*) AS n FROM transactions`)).toEqual({ n: 0 })
    expect(await db.first(`SELECT current_cents AS n FROM accounts WHERE id = ?`, [accountId])).toEqual({ n: 0 })
    const giftId = (toGift.body as { id: number }).id

    const back = await json(app, `/api/v1/gifts/${giftId}/to-transaction`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'expense',
        amount_cents: 80000,
        date: '2026-10-01',
        account_id: accountId,
        category_id: categoryId,
        note: '随礼',
      }),
    })
    expect(back.status).toBe(201)
    expect(await db.first(`SELECT COUNT(*) AS n FROM gifts`)).toEqual({ n: 0 })
    expect(await db.first(`SELECT kind, amount_cents, note FROM transactions`)).toEqual({
      kind: 'expense',
      amount_cents: 80000,
      note: '随礼',
    })
    expect(await db.first(`SELECT current_cents AS n FROM accounts WHERE id = ?`, [accountId])).toEqual({ n: -80000 })
  })
})

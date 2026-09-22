import { describe, expect, it, afterEach } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import { detectFavor, parseUtterances } from '../src/imports/favor.ts'
import { transcribeChain, type AsrProfile } from '../src/speech/asr.ts'

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
      name: partial.id,
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
        profile({ id: 'a', model: 'bad', sortOrder: 0 }),
        profile({ id: 'off', model: 'skip', enabled: false, sortOrder: 1 }),
        profile({ id: 'b', model: 'XingChenAGI/XingChenASR-V3.2-Ultra', sortOrder: 2 }),
      ],
      { bytes: new Uint8Array([1, 2, 3]), filename: 'a.webm', mime: 'audio/webm' },
    )
    expect(res).toMatchObject({ ok: true, text: '给张三随了500', profile: 'b' })
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

    const rows = await db.all<{ name: string }>('SELECT name FROM asr_profiles ORDER BY sort_order')
    expect(rows.map((row) => row.name)).toEqual(['主', '备'])
  })
})

describe('自然语言入账', () => {
  it('随礼同时记流水和人情，原文与录音都不入库', async () => {
    const { app, db } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'speaker', password: 'password1' }),
    })
    const token = (reg.body as { token: string; ledgers: { id: string }[] }).token
    const ledgerId = (reg.body as { ledgers: { id: string }[] }).ledgers[0].id
    const headers = { authorization: `Bearer ${token}`, 'x-ledger-id': ledgerId, 'content-type': 'application/json' }
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

  it('配置了 AI 时用模型结果，模型失败则退回规则', async () => {
    const original = globalThis.fetch
    const { app, db } = await setup()
    const reg = await json(app, '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'speakerai', password: 'password1' }),
    })
    const token = (reg.body as { token: string; ledgers: { id: string }[] }).token
    const ledgerId = (reg.body as { ledgers: { id: string }[] }).ledgers[0].id
    const headers = { authorization: `Bearer ${token}`, 'x-ledger-id': ledgerId, 'content-type': 'application/json' }
    await db.run(
      `INSERT INTO ai_settings (id, name, enabled, base_url, api_key, model, sort_order, updated_at)
       VALUES ('default', '测', 1, 'https://example.com/v1', 'sk-test', 'demo', 0, 1)`,
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

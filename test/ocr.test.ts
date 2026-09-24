/**
 * 拍照识别（OCR）链路测试。
 *
 * 守三件事：
 *   1. 端点归一化 —— 后台填 host / host/v1 / 完整路径三种写法都要能拼对，
 *      拼错的表现是模型侧 404，而这个错误会被接力逻辑当成「这一套挂了」悄悄跳到下一套，
 *      最后只看到「都失败了」，很难倒查到是 URL 的问题；
 *   2. 识别文本清理 —— OCR 输出带版面标记时，不收拾会污染第二步断句；
 *   3. 图片入参的边界 —— 类型白名单、体积、base64 合法性，两条送法（multipart / JSON）
 *      必须落在同一套校验上。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'
import {
  bytesToBase64,
  normalizeOcrText,
  resolveOcrEndpoint,
  recognizeChain,
  toDataUrl,
  type OcrProfile,
} from '../src/ocr/vision.ts'

async function setup() {
  const db = createSqliteDb(':memory:')
  await ensureMigrated(db)
  const app = createApp({ db, jwtSecret: 'test-secret-test-secret', adminToken: 'admin-secret' })
  return { app, db }
}

/**
 * 带登录态的 app。
 *
 * 注意 /ocr/status 只是「不需要账本头」（LEDGER_OPTIONAL），**仍然要登录** ——
 * 小程序那边调用时 token 是自动挂上的，所以这里也得先注册一个用户。
 */
async function setupAuthed() {
  const { app, db } = await setup()
  const reg = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ocruser', password: 'password1' }),
  })
  const session = (await reg.json()) as { token: string; ledgers: { id: string }[] }
  return {
    app,
    db,
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-ledger-id': session.ledgers[0].id,
      'content-type': 'application/json',
    } as Record<string, string>,
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
  return { status: res.status, body: body as Record<string, unknown> }
}

/** 一张最小的 PNG 头，够过类型嗅探。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])

function profile(partial: Partial<OcrProfile> & Pick<OcrProfile, 'id' | 'model'>): OcrProfile {
  return {
    name: String(partial.id),
    enabled: true,
    protocol: 'openai-vision',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: 'sk-test',
    sortOrder: 0,
    updatedAt: 0,
    ...partial,
  }
}

describe('OCR 端点归一化', () => {
  it('host / host/v1 / 完整路径 三种写法都能拼对', () => {
    const want = 'https://api.siliconflow.cn/v1/chat/completions'
    expect(resolveOcrEndpoint('https://api.siliconflow.cn')).toBe(want)
    expect(resolveOcrEndpoint('https://api.siliconflow.cn/v1')).toBe(want)
    expect(resolveOcrEndpoint('https://api.siliconflow.cn/v1/')).toBe(want)
    expect(resolveOcrEndpoint(want)).toBe(want)
    // 自定义版本号（/v2）不该被再拼一层 /v1
    expect(resolveOcrEndpoint('https://x.example/v2')).toBe('https://x.example/v2/chat/completions')
    expect(resolveOcrEndpoint('   ')).toBe('')
  })
})

describe('OCR 输出清理', () => {
  it('版面标记换成换行与空格，正文里的尖括号不动', () => {
    expect(normalizeOcrText('合计<nl>23.00<nl>')).toBe('合计\n23.00')
    expect(normalizeOcrText('<fcel>项目<fcel>金额<ecel><nl>午饭<fcel>23.00')).toBe('项目 金额\n午饭 23.00')
    // 白名单外的标签保留：正文里正当的尖括号内容不能被误删
    expect(normalizeOcrText('备注 <重要> 别删')).toBe('备注 <重要> 别删')
    expect(normalizeOcrText('\n\n\n\n')).toBe('')
  })
})

describe('OCR 图片入参', () => {
  it('base64 与 data URL', () => {
    expect(bytesToBase64(PNG)).toBe(Buffer.from(PNG).toString('base64'))
    expect(toDataUrl({ bytes: PNG, filename: 'a.png', mime: 'image/png' })).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    )
    // 类型不认识时降级成 jpeg，而不是把空 mime 拼进 data URL
    expect(toDataUrl({ bytes: PNG, filename: 'a', mime: 'image/tiff' })).toContain('data:image/jpeg;base64,')
  })
})

describe('OCR 多套接力', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('第一套失败才用下一套，停用的不参与', async () => {
    const called: string[] = []
    const maxTokens: number[] = []
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string; max_tokens: number }
      const model = String(request.model)
      called.push(model)
      maxTokens.push(request.max_tokens)
      if (model === 'bad') return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ choices: [{ message: { content: '合计 23.00' } }] }), {
        status: 200,
      })
    }
    const res = await recognizeChain(
      [
        profile({ id: 1, model: 'bad', sortOrder: 0 }),
        profile({ id: 2, model: 'off', enabled: false, sortOrder: 1 }),
        profile({ id: 3, model: 'good', sortOrder: 2 }),
      ],
      { bytes: PNG, filename: 'p.png', mime: 'image/png' },
    )
    expect(res).toEqual({ ok: true, text: '合计 23.00', profile: '3' })
    expect(called).toEqual(['bad', 'good'])
    expect(maxTokens).toEqual([4096, 4096])
  })

  it('全都失败时把每套的原因汇总，而不是只报最后一条', async () => {
    globalThis.fetch = async () => new Response('boom', { status: 503 })
    const res = await recognizeChain([profile({ id: 1, model: 'm1' }), profile({ id: 2, model: 'm2' })], {
      bytes: PNG,
      filename: 'p.png',
      mime: 'image/png',
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('1')
    expect(res.error).toContain('2')
    expect(res.error).toContain('503')
  })

  it('一套都没配时不发请求', async () => {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }
    const res = await recognizeChain([profile({ id: 1, model: 'm', enabled: false })], {
      bytes: PNG,
      filename: 'p.png',
      mime: 'image/png',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('没有可用')
    expect(calls).toBe(0)
  })

  it('返回里没有文字也算失败，会换下一套', async () => {
    const called: string[] = []
    globalThis.fetch = async (_url, init) => {
      const model = String(JSON.parse(String(init?.body)).model)
      called.push(model)
      if (model === 'm1') return new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), { status: 200 })
      return new Response(JSON.stringify({ choices: [{ message: { content: '午饭 23' } }] }), { status: 200 })
    }
    const res = await recognizeChain([profile({ id: 1, model: 'm1' }), profile({ id: 2, model: 'm2' })], {
      bytes: PNG,
      filename: 'p.png',
      mime: 'image/png',
    })
    expect(res.ok).toBe(true)
    expect(called).toEqual(['m1', 'm2'])
  })
})

describe('OCR 接口：两条送法共用一套校验', () => {
  it('没配模型时 /ocr/status 是 false，/ocr/scan 报 502 而不是 500', async () => {
    const { app, headers } = await setupAuthed()
    const status = await json(app, '/api/v1/ocr/status', { headers })
    expect(status.body).toEqual({ available: false })

    const form = new FormData()
    form.set('file', new File([PNG], 'a.png', { type: 'image/png' }))
    const scan = await json(app, '/api/v1/ocr/scan', {
      method: 'POST',
      headers: { authorization: headers.authorization, 'x-ledger-id': headers['x-ledger-id'] },
      body: form,
    })
    expect(scan.status).toBe(502)
    expect(scan.body.code).toBe('ocr_failed')
  })

  it('JSON 送法：缺图 / 坏 base64 / 类型不在白名单，都在本地挡掉', async () => {
    const { app, headers } = await setupAuthed()
    const post = (payload: unknown) =>
      json(app, '/api/v1/ocr/scan', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })

    expect((await post({})).status).toBe(400)
    expect((await post({ image_base64: 'not-base64!!' })).status).toBe(400)
    expect((await post({ image_base64: bytesToBase64(PNG), mime: 'image/tiff' })).status).toBe(400)
    expect((await post({ image_base64: '' })).status).toBe(400)
  })

  it('JSON 送法：类型缺失时按文件头嗅探，能一路走到「没配模型」这一步', async () => {
    const { app, headers } = await setupAuthed()
    const res = await json(app, '/api/v1/ocr/scan', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image_base64: `data:image/png;base64,${bytesToBase64(PNG)}` }),
    })
    // 502 说明图已经过了类型与体积校验，卡在「没有可用配置」——
    // 若嗅探失败会先返回 400，那就到不了这里。
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('ocr_failed')
  })

  it('multipart 送法：分片类型不在白名单时 400', async () => {
    const { app, headers } = await setupAuthed()
    const form = new FormData()
    form.set('file', new File([PNG], 'a.gif', { type: 'image/gif' }))
    const res = await json(app, '/api/v1/ocr/scan', {
      method: 'POST',
      headers: { authorization: headers.authorization, 'x-ledger-id': headers['x-ledger-id'] },
      body: form,
    })
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toContain('JPG')
  })

  it('没登录时 /ocr/status 也要 401（免账本不等于免登录）', async () => {
    const { app } = await setup()
    const res = await json(app, '/api/v1/ocr/status')
    expect(res.status).toBe(401)
  })
})

describe('OCR 结果 → 流水行', () => {
  it('认得字但没配文本解析模型：明说「没配置」，不吐错行', async () => {
    const { app, headers } = await setupAuthed()

    const res = await json(app, '/api/v1/imports/receipt', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '合计 23.00\n2026-09-23 午饭' }),
    })
    expect(res.status).toBe(200)
    // 关键：parser 是 none、items 为空、ai_error 说明原因 ——
    // 界面据此把识别出的原文直接摆给用户，而不是让人对着一堆错行逐条删。
    expect(res.body.parser).toBe('none')
    expect(res.body.items).toEqual([])
    expect(String(res.body.ai_error)).toContain('AI 配置')

    const empty = await json(app, '/api/v1/imports/receipt', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '   ' }),
    })
    expect(empty.status).toBe(400)
  })
})

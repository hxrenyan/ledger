import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { signAdminToken } from '../auth/jwt.ts'
import { badRequest, notFound, unauthorized } from '../http.ts'
import { parseId, routeId } from '../id.ts'
import { readAiConfigs, replaceAiConfigs, resolveEndpoint, testAi, toPublicAi, type AiConfig } from '../imports/ai.ts'
import { readAudio } from './speech.ts'
import { readAsrProfiles, replaceAsrProfiles, toPublicAsr, transcribeOne, type AsrProfile } from '../speech/asr.ts'
import { OCR_PROTOCOL, readOcrProfiles, recognizeOne, replaceOcrProfiles, toPublicOcr, type OcrProfile } from '../ocr/vision.ts'
import { imageFromFile } from './ocr.ts'

export function registerAdminRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/admin/login', async (c) => {
    const expected = c.get('adminToken')
    if (!expected) throw unauthorized('未配置管理员口令')
    const body = await c.req.json().catch(() => ({}))
    const password = typeof body.password === 'string' ? body.password : ''
    if (password !== expected) throw unauthorized('管理员口令错误')
    const token = await signAdminToken(c.get('jwtSecret'))
    return c.json({ token })
  })

  app.get('/api/v1/admin/overview', async (c) => {
    const db = c.get('db')
    const users = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)
    const ledgers = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ledgers`)
    const txs = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions`)
    const disabled = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE disabled = 1`)
    return c.json({
      users: Number(users?.n ?? 0),
      ledgers: Number(ledgers?.n ?? 0),
      transactions: Number(txs?.n ?? 0),
      disabled_users: Number(disabled?.n ?? 0),
    })
  })

  app.get('/api/v1/admin/users', async (c) => {
    const rows = await c.get('db').all<{
      id: number
      username: string
      nickname: string
      disabled: number
      created_at: number
      ledger_count: number
    }>(
      `SELECT u.id, u.username, u.nickname, u.disabled, u.created_at,
              (SELECT COUNT(*) FROM members m WHERE m.user_id = u.id) AS ledger_count
       FROM users u
       ORDER BY u.created_at DESC`,
    )
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        nickname: r.nickname,
        disabled: !!r.disabled,
        created_at: r.created_at,
        ledger_count: Number(r.ledger_count),
      })),
    })
  })

  app.patch('/api/v1/admin/users/:id', async (c) => {
    const id = routeId(c.req.param('id'), '用户')
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.disabled !== 'boolean') throw badRequest('请提供 disabled')
    const db = c.get('db')
    const user = await db.first(`SELECT id FROM users WHERE id = ?`, [id])
    if (!user) throw notFound('用户不存在')
    await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, [body.disabled ? 1 : 0, id])
    return c.json({ id, disabled: body.disabled })
  })

  app.get('/api/v1/admin/ledgers', async (c) => {    const rows = await c.get('db').all<{
      id: number
      name: string
      owner_username: string
      member_count: number
      tx_count: number
      created_at: number
    }>(
      `SELECT l.id, l.name, l.created_at, u.username AS owner_username,
              (SELECT COUNT(*) FROM members m WHERE m.ledger_id = l.id) AS member_count,
              (SELECT COUNT(*) FROM transactions t WHERE t.ledger_id = l.id) AS tx_count
       FROM ledgers l
       JOIN users u ON u.id = l.owner_id
       ORDER BY l.created_at DESC`,
    )
    return c.json({
      items: rows.map((r) => ({
        ...r,
        member_count: Number(r.member_count),
        tx_count: Number(r.tx_count),
      })),
    })
  })

  // -------------------------------------------------------------------------
  // AI 配置：多套，按数组顺序失败换下一套。api_key 只回显掩码。
  // -------------------------------------------------------------------------
  app.get('/api/v1/admin/ai', async (c) => {
    const items = await readAiConfigs(c.get('db'))
    return c.json({ items: items.map(toPublicAi) })
  })

  app.put('/api/v1/admin/ai', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const items = await replaceAiConfigs(c.get('db'), body?.items)
    return c.json({ ok: true, items: items.map(toPublicAi) })
  })

  /** 测一套，不走接力。密钥留空则用该 id 已保存的。 */
  app.post('/api/v1/admin/ai/test', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const id = parseId(body.id)
    const stored = id == null ? undefined : (await readAiConfigs(c.get('db'))).find((item) => item.id === id)
    const cfg: AiConfig = {
      id: stored?.id ?? 0,
      name: typeof body.name === 'string' ? body.name : (stored?.name ?? ''),
      enabled: true,
      baseUrl: typeof body.base_url === 'string' && body.base_url.trim() ? body.base_url.trim() : (stored?.baseUrl ?? ''),
      apiKey: typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : (stored?.apiKey ?? ''),
      model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (stored?.model ?? ''),
      sortOrder: 0,
    }
    const res = await testAi(cfg)
    if (!res.ok) return c.json({ ok: false, message: res.error, endpoint: resolveEndpoint(cfg.baseUrl) })
    return c.json({
      ok: true,
      latency_ms: res.data.latencyMs,
      sample: res.data.sample,
      endpoint: resolveEndpoint(cfg.baseUrl),
    })
  })

  // -----------------------------------------------------------------------
  // 语音识别：多套，按数组顺序接力。api_key 只回显掩码。
  // -----------------------------------------------------------------------
  app.get('/api/v1/admin/asr', async (c) => {
    const items = await readAsrProfiles(c.get('db'))
    return c.json({ items: items.map(toPublicAsr) })
  })

  app.put('/api/v1/admin/asr', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const items = await replaceAsrProfiles(c.get('db'), body?.items)
    return c.json({ ok: true, items: items.map(toPublicAsr) })
  })

  /** 测一套，不走接力。可以带未保存的表单值；密钥留空则用该 id 已存的。 */
  app.post('/api/v1/admin/asr/test', async (c) => {
    const form = await c.req.raw.formData().catch(() => null)
    if (!form) throw badRequest('请上传音频')
    const audio = await readAudio(form)
    const id = parseId(form.get('id'))
    const stored = id == null ? undefined : (await readAsrProfiles(c.get('db'))).find((p) => p.id === id)
    const profile: AsrProfile = {
      id: stored?.id ?? 0,
      name: typeof form.get('name') === 'string' ? String(form.get('name')) : (stored?.name ?? ''),
      enabled: true,
      protocol: 'openai-audio',
      baseUrl: strField(form, 'base_url') || stored?.baseUrl || '',
      apiKey: strField(form, 'api_key') || stored?.apiKey || '',
      model: strField(form, 'model') || stored?.model || '',
      sortOrder: 0,
      updatedAt: 0,
    }
    const res = await transcribeOne(profile, audio)
    if (!res.ok) return c.json({ ok: false, message: res.error })
    return c.json({ ok: true, text: res.text })
  })

  // -----------------------------------------------------------------------
  // 图片识别：同样多套接力。图片只在识别服务的内存里过一遍，不落库。
  // -----------------------------------------------------------------------
  app.get('/api/v1/admin/ocr', async (c) => {
    const items = await readOcrProfiles(c.get('db'))
    return c.json({ items: items.map(toPublicOcr) })
  })

  app.put('/api/v1/admin/ocr', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const items = await replaceOcrProfiles(c.get('db'), body?.items)
    return c.json({ ok: true, items: items.map(toPublicOcr) })
  })

  /** 测一套，不走接力。可以带未保存的表单值；密钥留空则用该 id 已存的。 */
  app.post('/api/v1/admin/ocr/test', async (c) => {
    const form = await c.req.raw.formData().catch(() => null)
    if (!form) throw badRequest('请上传图片')
    const file = form.get('file')
    if (!(file instanceof File)) throw badRequest('请上传图片')
    const image = await imageFromFile(file)
    const id = parseId(form.get('id'))
    const stored = id == null ? undefined : (await readOcrProfiles(c.get('db'))).find((p) => p.id === id)
    const profile: OcrProfile = {
      id: stored?.id ?? 0,
      name: typeof form.get('name') === 'string' ? String(form.get('name')) : (stored?.name ?? ''),
      enabled: true,
      protocol: OCR_PROTOCOL,
      baseUrl: strField(form, 'base_url') || stored?.baseUrl || '',
      apiKey: strField(form, 'api_key') || stored?.apiKey || '',
      model: strField(form, 'model') || stored?.model || '',
      sortOrder: 0,
      updatedAt: 0,
    }
    const started = Date.now()
    const res = await recognizeOne(profile, image)
    if (!res.ok) return c.json({ ok: false, message: res.error })
    return c.json({ ok: true, latency_ms: Date.now() - started, chars: res.text.length, text: res.text })
  })
}

function strField(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

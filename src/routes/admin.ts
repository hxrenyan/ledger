import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { signAdminToken } from '../auth/jwt.ts'
import { readWechatAdminConfig, saveWechatAdminConfig } from '../auth/wechatConfig.ts'
import { badRequest, notFound, unauthorized } from '../http.ts'
import { parseId, routeId } from '../id.ts'
import { readAiConfigs, replaceAiConfigs, resolveEndpoint, testAi, toPublicAi, type AiConfig } from '../imports/ai.ts'
import { readAudio } from './speech.ts'
import { readAsrProfiles, replaceAsrProfiles, toPublicAsr, transcribeOne, type AsrProfile } from '../speech/asr.ts'
import { OCR_PROTOCOL, readOcrProfiles, recognizeOne, replaceOcrProfiles, toPublicOcr, type OcrProfile } from '../ocr/vision.ts'
import { imageFromFile } from './ocr.ts'
import { adjustPoints, adjustPointsMany, assertWechatUser, listPointEntries, listWechatPointUsers } from '../points/adjust.ts'
import { recognitionRestricted, setRecognitionRestricted } from '../points/wallet.ts'
import { listAdminFeedback, parseFeedbackStatus, updateFeedback } from '../feedback/service.ts'

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
    const row = await c.get('db').first<{
      users: number
      ledgers: number
      transactions: number
      disabled_users: number
    }>(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM ledgers) AS ledgers,
         (SELECT COUNT(*) FROM transactions) AS transactions,
         (SELECT COUNT(*) FROM users WHERE disabled = 1) AS disabled_users`,
    )
    return c.json({
      users: Number(row?.users ?? 0),
      ledgers: Number(row?.ledgers ?? 0),
      transactions: Number(row?.transactions ?? 0),
      disabled_users: Number(row?.disabled_users ?? 0),
    })
  })

  app.get('/api/v1/admin/users', async (c) => {
    const status = c.req.query('status') || 'all'
    if (status !== 'all' && status !== 'active' && status !== 'disabled') {
      throw badRequest('状态只能是 all、active 或 disabled')
    }
    const like = searchLike(c.req.query('q'), true)
    const where: string[] = []
    const args: unknown[] = []
    if (like) {
      where.push(`(u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')`)
      args.push(like, like)
    }
    if (status === 'active') where.push('u.disabled = 0')
    if (status === 'disabled') where.push('u.disabled = 1')
    const rows = await c.get('db').all<{
      id: number
      username: string
      nickname: string
      disabled: number
      created_at: number
      last_seen_at: number | null
      ledger_count: number
    }>(
      `SELECT u.id, u.username, u.nickname, u.disabled, u.created_at, u.last_seen_at,
              COUNT(m.ledger_id) AS ledger_count
       FROM users u
       LEFT JOIN members m ON m.user_id = u.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
      args,
    )
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        username: r.username,
        nickname: r.nickname,
        disabled: !!r.disabled,
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        ledger_count: Number(r.ledger_count),
      })),
    })
  })

  app.patch('/api/v1/admin/users/:id', async (c) => {
    const id = recordId(c.req.param('id'), '用户')
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.disabled !== 'boolean') throw badRequest('请提供 disabled')
    const db = c.get('db')
    const user = await db.first(`SELECT id FROM users WHERE id = ?`, [id])
    if (!user) throw notFound('用户不存在')
    await db.run(`UPDATE users SET disabled = ? WHERE id = ?`, [body.disabled ? 1 : 0, id])
    return c.json({ id, disabled: body.disabled })
  })

  app.get('/api/v1/admin/points', async (c) => {
    return c.json({ items: await listWechatPointUsers(c.get('db'), searchLike(c.req.query('q'), true)) })
  })

  app.post('/api/v1/admin/points', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (!Array.isArray(body.user_ids) || typeof body.delta !== 'number' || typeof body.note !== 'string') {
      throw badRequest('请选择用户，并填写积分变动和备注')
    }
    const userIds = body.user_ids.map((id: unknown) => recordId(id, '用户'))
    const items = await adjustPointsMany(c.get('db'), userIds, body.delta, body.note)
    return c.json({ items })
  })

  app.get('/api/v1/admin/users/:id/points', async (c) => {
    const id = recordId(c.req.param('id'), '用户')
    const db = c.get('db')
    await assertWechatUser(db, id)
    const account = await db.first<{ balance: number }>(`SELECT balance FROM point_accounts WHERE user_id = ?`, [id])
    const items = await listPointEntries(db, id)
    return c.json({ balance: Number(account?.balance ?? 0), items })
  })

  app.post('/api/v1/admin/users/:id/points', async (c) => {
    const id = recordId(c.req.param('id'), '用户')
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.delta !== 'number' || typeof body.note !== 'string') throw badRequest('请提供积分变动和备注')
    const entry = await adjustPoints(c.get('db'), id, body.delta, body.note)
    return c.json({ balance: entry.balance_after, entry })
  })

  app.get('/api/v1/admin/feedbacks', async (c) => {
    const status = parseFeedbackStatus(c.req.query('status') || 'open')
    if (!status) throw badRequest('状态只能是 open、done 或 all')
    return c.json({ items: await listAdminFeedback(c.get('db'), status, searchLike(c.req.query('q'))) })
  })

  app.patch('/api/v1/admin/feedbacks/:id', async (c) => {
    const id = routeId(c.req.param('id'), '反馈')
    const body = await c.req.json().catch(() => ({}))
    const status = body.status == null ? undefined : parseFeedbackStatus(body.status)
    if (body.status != null && (status == null || status === 'all')) throw badRequest('状态只能是 open 或 done')
    if (body.reply != null && typeof body.reply !== 'string') throw badRequest('回复须为文字')
    if (typeof body.reply === 'string' && body.reply.trim().length > 500) throw badRequest('回复最多 500 字')
    const reply = typeof body.reply === 'string' ? body.reply.trim() : undefined
    const nextStatus = status === 'open' || status === 'done' ? status : undefined
    const item = await updateFeedback(c.get('db'), id, nextStatus, reply)
    return c.json(item)
  })

  app.get('/api/v1/admin/ledgers', async (c) => {
    const like = searchLike(c.req.query('q'), true)
    const rows = await c.get('db').all<{
      id: number
      name: string
      owner_username: string
      member_count: number
      tx_count: number
      created_at: number
      last_seen_at: number | null
    }>(
      `SELECT l.id, l.name, l.created_at, l.last_seen_at, u.username AS owner_username,
              COALESCE(mc.n, 0) AS member_count,
              COALESCE(tc.n, 0) AS tx_count
       FROM ledgers l
       JOIN users u ON u.id = l.owner_id
       LEFT JOIN (
         SELECT ledger_id, COUNT(*) AS n FROM members GROUP BY ledger_id
       ) mc ON mc.ledger_id = l.id
       LEFT JOIN (
         SELECT ledger_id, COUNT(*) AS n FROM transactions GROUP BY ledger_id
       ) tc ON tc.ledger_id = l.id
       ${like ? `WHERE (l.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')` : ''}
       ORDER BY l.created_at DESC`,
      like ? [like, like, like] : [],
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

  // 小程序登录凭证。AppSecret 只回显掩码；留空表示不改已保存的值。
  app.get('/api/v1/admin/wechat', async (c) => {
    return c.json(await readWechatAdminConfig(c.get('db')))
  })

  app.put('/api/v1/admin/wechat', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    return c.json(await saveWechatAdminConfig(c.get('db'), body))
  })

  app.get('/api/v1/admin/recognition', async (c) => {
    return c.json({ restricted: await recognitionRestricted(c.get('db')) })
  })

  app.put('/api/v1/admin/recognition', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { restricted?: unknown }
    const restricted = body.restricted === true || body.restricted === 1 || body.restricted === '1'
    return c.json(await setRecognitionRestricted(c.get('db'), restricted))
  })
}

function strField(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

/** 新库是正整数。旧本地库的用户主键仍是 UUID，列表原样返回，按钮也要认。 */
function recordId(value: unknown, label: string): number | string {
  const parsed = parseId(value)
  if (parsed != null) return parsed
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value
  }
  throw badRequest(`${label}无效`)
}

/** 后台搜索词。空串不筛选。用户、账本、积分会去掉开头的 @。 */
function searchLike(raw: string | undefined, stripAt = false): string | null {
  let text = (raw ?? '').trim()
  if (stripAt) text = text.replace(/^@+/, '')
  if (!text) return null
  if (text.length > 40) throw badRequest('搜索词最多 40 字')
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

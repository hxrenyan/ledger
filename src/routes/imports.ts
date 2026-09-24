import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest } from '../http.ts'
import { routeId } from '../id.ts'
import { buildPreview, commitImport, listBatches, previewUtterances, suggestWithAi, undoBatch } from '../imports/service.ts'

/**
 * 单次上传的文本上限。原始文件和语音都不落库：
 * 账单在浏览器里解析后只提交文本或二维表；语音只在识别接口的内存里转写。
 * 这里保存的是解析后的流水 / 人情记录，以及批次上的文件名（方便辨认），没有文件正文。
 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024

export function registerImportRoutes(app: Hono<AppEnv>) {
  app.post('/api/v1/imports/preview', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const kind = body?.kind === 'rows' ? 'rows' : 'text'
    const text = typeof body?.text === 'string' ? body.text : ''
    if (kind === 'text' && text.length > MAX_TEXT_BYTES) {
      throw badRequest('文件过大（超过 4MB），请拆分后分次导入')
    }
    const result = await buildPreview(
      c.get('db'),
      c.get('ledgerId'),
      {
        kind,
        text,
        rows: body?.rows,
        filename: typeof body?.filename === 'string' ? body.filename.slice(0, 200) : '',
        sheet: typeof body?.sheet === 'string' ? body.sheet.slice(0, 100) : undefined,
      },
      { useAi: body?.use_ai === true },
    )
    return c.json(result)
  })

  app.post('/api/v1/imports/utterances', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.length > 8000) throw badRequest('文本过长')
    const preview = await previewUtterances(c.get('db'), c.get('ledgerId'), text)
    return c.json(preview)
  })

  /**
   * 图片识别出来的文字 → 流水行。
   * 和 /imports/utterances 是同一条下游（核对、提交都共用 /imports/commit），
   * 差别只在提示词：口语那句一句一笔，票据这段要区分实付金额与余额、明细与合计。
   */
  app.post('/api/v1/imports/receipt', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const text = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) throw badRequest('没有可解析的文字')
    if (text.length > 20000) throw badRequest('文字过长')
    const preview = await previewUtterances(c.get('db'), c.get('ledgerId'), text, 'photo')
    return c.json(preview)
  })

  app.post('/api/v1/imports/suggest', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const list = Array.isArray(body?.rows) ? body.rows : []
    if (!list.length) throw badRequest('没有需要建议的行')
    if (list.length > 300) throw badRequest('单次最多建议 300 行')
    const rows = list
      .map((r: Record<string, unknown>, index: number) => ({
        i: Number.isInteger(Number(r?.i)) ? Number(r.i) : index,
        note: typeof r?.note === 'string' ? r.note.slice(0, 200) : '',
        counterparty: typeof r?.counterparty === 'string' ? r.counterparty.slice(0, 200) : '',
        direction: r?.direction === 'income' ? ('income' as const) : ('expense' as const),
        amount_cents: typeof r?.amount_cents === 'number' ? r.amount_cents : 0,
      }))
      .filter((r: { direction: string }) => r.direction === 'expense' || r.direction === 'income')
    const result = await suggestWithAi(c.get('db'), rows)
    return c.json(result)
  })

  app.post('/api/v1/imports/commit', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await commitImport(c.get('db'), c.get('ledgerId'), c.get('userId'), body ?? {})
    return c.json(result, 201)
  })

  app.get('/api/v1/imports/batches', async (c) => {
    const limitRaw = Number(c.req.query('limit') ?? 20)
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20
    const items = await listBatches(c.get('db'), c.get('ledgerId'), limit)
    return c.json({ items })
  })

  app.post('/api/v1/imports/batches/:id/undo', async (c) => {
    const result = await undoBatch(c.get('db'), c.get('ledgerId'), routeId(c.req.param('id'), '批次'))
    return c.json({ ok: true, ...result })
  })
}

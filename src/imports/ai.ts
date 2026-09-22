/**
 * AI 兜底：OpenAI 兼容的 chat/completions。
 *
 * 用途只有两个，且都在规则解析之后：
 *   1. 表格结构识别不出来时，把行丢给模型转成统一字段
 *   2. 给备注/对方建议分类（用户在预览页可改）
 *
 * 没配置 AI 时一切照常：规则解析先跑，AI 只是补位，失败也只降级不报错。
 */

import type { Db, Stmt } from '../db/types.ts'
import { badRequest } from '../http.ts'
import { newId } from '../seed.ts'
import { parseAmountCents, parseDateYmd, parseDirection, type Direction } from './values.ts'

export const MAX_AI_PROFILES = 8

export type AiConfig = {
  id: string
  name: string
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  sortOrder: number
  updatedAt?: number
}

/** AI 一次最多处理的行数与分块大小（成本与延迟的折中）。 */
export const AI_MAX_ROWS = 200
const AI_CHUNK = 50
const CELL_LIMIT = 60
const REQUEST_TIMEOUT_MS = 60_000

export function aiReady(cfg: AiConfig): boolean {
  return !!cfg.enabled && !!cfg.baseUrl.trim() && !!cfg.apiKey.trim() && !!cfg.model.trim()
}

export function aiLabel(cfg: AiConfig): string {
  return cfg.name.trim() || cfg.model.trim() || '未命名配置'
}

export async function readAiConfigs(db: Db): Promise<AiConfig[]> {
  const rows = await db.all<{
    id: string
    name: string
    enabled: number
    base_url: string
    api_key: string
    model: string
    sort_order: number
    updated_at: number
  }>(
    `SELECT id, name, enabled, base_url, api_key, model, sort_order, updated_at
     FROM ai_settings
     ORDER BY sort_order ASC, updated_at ASC, id ASC`,
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    enabled: !!row.enabled,
    baseUrl: row.base_url ?? '',
    apiKey: row.api_key ?? '',
    model: row.model ?? '',
    sortOrder: Number(row.sort_order) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }))
}

type SaveItem = {
  id?: unknown
  name?: unknown
  enabled?: unknown
  base_url?: unknown
  model?: unknown
  api_key?: unknown
  clear_key?: unknown
}

/** 按数组顺序整表替换。下标就是失败后的接力顺序。 */
export async function replaceAiConfigs(db: Db, items: unknown): Promise<AiConfig[]> {
  if (!Array.isArray(items)) throw badRequest('请提供 items 数组')
  if (items.length > MAX_AI_PROFILES) throw badRequest(`最多 ${MAX_AI_PROFILES} 套 AI 配置`)
  const existing = await readAiConfigs(db)
  const byId = new Map(existing.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const now = Date.now()
  const next: AiConfig[] = []

  items.forEach((raw, index) => {
    const item = (raw ?? {}) as SaveItem
    const requestedId = typeof item.id === 'string' ? item.id.trim() : ''
    const prev = requestedId ? byId.get(requestedId) : undefined
    const id = prev ? prev.id : newId()
    if (seen.has(id)) throw badRequest('配置 id 重复')
    seen.add(id)

    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 40) : (prev?.name ?? '')
    const enabled = item.enabled === true
    const baseUrl = typeof item.base_url === 'string' ? item.base_url.trim().slice(0, 300) : (prev?.baseUrl ?? '')
    const model = typeof item.model === 'string' ? item.model.trim().slice(0, 80) : (prev?.model ?? '')
    let apiKey = prev?.apiKey ?? ''
    if (item.clear_key === true) apiKey = ''
    else if (typeof item.api_key === 'string' && item.api_key.trim()) apiKey = item.api_key.trim()

    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw badRequest(`第 ${index + 1} 套的 base_url 需以 http(s):// 开头`)
    if (enabled && (!baseUrl || !apiKey || !model)) {
      throw badRequest(`第 ${index + 1} 套要参与接力，需要同时填写 base_url、api_key、model`)
    }
    next.push({ id, name, enabled, baseUrl, apiKey, model, sortOrder: index, updatedAt: now })
  })

  const stmts: Stmt[] = []
  for (const old of existing) {
    if (!seen.has(old.id)) stmts.push({ sql: `DELETE FROM ai_settings WHERE id = ?`, params: [old.id] })
  }
  for (const row of next) {
    stmts.push({
      sql: `INSERT INTO ai_settings (id, name, enabled, base_url, api_key, model, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, enabled = excluded.enabled, base_url = excluded.base_url,
              api_key = excluded.api_key, model = excluded.model, sort_order = excluded.sort_order,
              updated_at = excluded.updated_at`,
      params: [row.id, row.name, row.enabled ? 1 : 0, row.baseUrl, row.apiKey, row.model, row.sortOrder, now],
    })
  }
  if (stmts.length) await db.batch(stmts)
  return readAiConfigs(db)
}

export function toPublicAi(cfg: AiConfig) {
  return {
    id: cfg.id,
    name: cfg.name,
    enabled: cfg.enabled,
    base_url: cfg.baseUrl,
    model: cfg.model,
    has_key: !!cfg.apiKey,
    key_hint: maskAiKey(cfg.apiKey),
    endpoint: cfg.baseUrl ? resolveEndpoint(cfg.baseUrl) : '',
    sort_order: cfg.sortOrder,
    updated_at: cfg.updatedAt ?? 0,
  }
}

function maskAiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

/** 按顺序尝试已启用且配置完整的套。上一套请求失败或返回不可用时换下一套。 */
export async function withAiFailover<T>(
  configs: AiConfig[],
  run: (cfg: AiConfig) => Promise<AiResult<T>>,
): Promise<AiResult<T>> {
  const ready = configs.filter(aiReady)
  if (!ready.length) return { ok: false, error: 'AI 未启用' }
  const errors: string[] = []
  for (const cfg of ready) {
    const res = await run(cfg)
    if (res.ok) return res
    const brief = res.error.replace(/\s+/g, ' ').trim()
    errors.push(`${aiLabel(cfg)}：${brief.length > 160 ? `${brief.slice(0, 160)}…` : brief}`)
  }
  return { ok: false, error: errors.join('；') }
}

/** base_url 归一化：支持 https://host、https://host/v1、以及完整 .../chat/completions。 */
export function resolveEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

export type AiResult<T> = { ok: true; data: T } | { ok: false; error: string }

type ChatMessage = { role: 'system' | 'user'; content: string }

type ChatOptions = {
  json?: boolean
  timeoutMs?: number
}

/** 调用一次 chat/completions，返回 content 文本。 */
export async function chat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<AiResult<string>> {
  const endpoint = resolveEndpoint(cfg.baseUrl)
  if (!endpoint || !cfg.apiKey || !cfg.model) return { ok: false, error: 'AI 未配置完整' }
  const withJson = opts.json !== false

  const attempt = async (jsonMode: boolean): Promise<AiResult<string>> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: 0,
      stream: false,
    }
    if (jsonMode) body.response_format = { type: 'json_object' }
    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: /abort|timeout/i.test(msg) ? 'AI 请求超时' : `AI 请求失败：${msg}` }
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      return { ok: false, error: `AI 返回 ${res.status}：${text || '无内容'}` }
    }
    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      return { ok: false, error: 'AI 返回不是 JSON' }
    }
    const choice = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'AI 返回内容为空' }
    return { ok: true, data: content }
  }

  const first = await attempt(withJson)
  if (first.ok) return first
  // 部分兼容网关不支持 response_format，去掉后重试一次
  if (withJson && /response_format|json_object|400|422/.test(first.error)) {
    return attempt(false)
  }
  return first
}

/** 从模型输出里尽力取出 JSON：直接解析失败时剥 ```json 围栏、再退到首尾括号截取。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const attempts: string[] = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  const start = trimmed.search(/[[{]/)
  if (start >= 0) {
    const lastObj = trimmed.lastIndexOf('}')
    const lastArr = trimmed.lastIndexOf(']')
    const end = Math.max(lastObj, lastArr)
    if (end > start) attempts.push(trimmed.slice(start, end + 1))
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* 试下一种 */
    }
  }
  return undefined
}

export type AiParsedRow = {
  row: number
  date: string
  amount_cents: number
  direction: Direction
  note: string
  counterparty: string
  category_name: string
  account_name: string
}

const PARSE_SYSTEM = `你是账单表格解析助手。输入是从账单文件（微信/支付宝/银行/自定义导出，或 Excel 转换结果）里提取的表格行，
每行以「原行号 + 制表符」开头，可能包含表头、说明行、合计行。
请把真实流水行转成统一字段，只输出 JSON：{"rows":[{"row":12,"date":"2024-01-02","amount":123.45,"direction":"expense","note":"午饭","counterparty":"某餐厅","category":"餐饮","account":"微信"}]}
规则：
- row 原样回填输入行号（不要改）
- date 用 YYYY-MM-DD，无法判断就留空字符串
- amount 为元、正数、最多两位小数，无法判断就留空字符串
- direction 只能是 expense（支出）或 income（收入）或 skip（不计收支/转账/中性）
- note、counterparty、category、account 尽力提取，没有就留空字符串
- 随礼、礼金、份子、压岁钱、人情：对方姓名写入 counterparty，事由留在 note，不要把人名丢掉
- category 优先从参考分类里挑；account 优先从参考账户里挑
- 跳过表头、说明、合计、分隔等非流水行，不要为它们输出
- 不要编造数据，不确定就留空`

function clip(v: string): string {
  const s = String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim()
  return s.length > CELL_LIMIT ? `${s.slice(0, CELL_LIMIT)}…` : s
}

/**
 * 把表格交给 AI 解析。行号用「源文件 1 基行号」，与规则解析的行号对齐。
 * 超过 AI_MAX_ROWS 的部分不送模型（成本保护），返回时标注截断。
 */
export async function aiParseTable(
  configs: AiConfig[],
  rows: string[][],
  ctx: { startRowNo: number; categories: string[]; accounts: string[] },
): Promise<AiResult<{ rows: AiParsedRow[]; truncated: boolean }>> {
  if (!configs.some(aiReady)) return { ok: false, error: 'AI 未启用' }
  if (!rows.length) return { ok: true, data: { rows: [], truncated: false } }

  const truncated = rows.length > AI_MAX_ROWS
  const usable = rows.slice(0, AI_MAX_ROWS)
  const out: AiParsedRow[] = []

  for (let offset = 0; offset < usable.length; offset += AI_CHUNK) {
    const chunk = usable.slice(offset, offset + AI_CHUNK)
    const lines = chunk.map((r, i) => `${ctx.startRowNo + offset + i}\t${r.map(clip).join('\t')}`).join('\n')
    const reference = [
      ctx.categories.length ? `参考分类：${ctx.categories.join('、')}` : '',
      ctx.accounts.length ? `参考账户：${ctx.accounts.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const res = await withAiFailover(configs, async (cfg) => {
      const chatRes = await chat(cfg, [
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content: `${reference}\n\n表格行：\n${lines}` },
      ])
      if (!chatRes.ok) return chatRes
      const parsed = extractJson(chatRes.data)
      const list = (parsed as { rows?: unknown })?.rows
      if (!Array.isArray(list)) return { ok: false, error: 'AI 输出格式不符合预期' }
      return { ok: true, data: list }
    })
    if (!res.ok) return res
    for (const item of res.data) {
      const row = shapeAiRow(item, ctx.startRowNo + offset)
      if (row) out.push(row)
    }
  }
  return { ok: true, data: { rows: out, truncated } }
}

function shapeAiRow(item: unknown, fallbackNo: number): AiParsedRow | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const amount = parseAmountCents(typeof o.amount === 'number' ? o.amount : String(o.amount ?? ''))
  if (amount === null || amount === 0) return null
  const rawDate = o.date
  const date = rawDate instanceof Date ? parseDateYmd(rawDate) : parseDateYmd(String(rawDate ?? ''))
  const rowNo = Number(o.row)
  const direction = parseDirection(String(o.direction ?? '')) ?? 'expense'
  return {
    row: Number.isInteger(rowNo) && rowNo > 0 ? rowNo : fallbackNo,
    date: date ?? '',
    amount_cents: Math.abs(amount),
    direction,
    note: str(o.note),
    counterparty: str(o.counterparty),
    category_name: str(o.category),
    account_name: str(o.account),
  }
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim().slice(0, 200)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

export type SuggestItem = {
  i: number
  note: string
  counterparty: string
  direction: 'expense' | 'income'
  amount_cents: number
}

const SUGGEST_SYSTEM = `你是记账分类助手。给你若干笔流水（含序号 i、备注、对方、方向），
以及可选的分类清单，请为每笔挑选最合适的分类，只输出 JSON：{"items":[{"i":0,"category":"餐饮"}]}
规则：category 必须来自给定分类清单，逐字一致；无法判断就省略该条；不要编造分类。`

/** 批量建议分类，返回 序号 → 分类名（只包含清单内的名字）。 */
export async function aiSuggestCategories(
  configs: AiConfig[],
  items: SuggestItem[],
  categories: string[],
): Promise<AiResult<Record<number, string>>> {
  if (!configs.some(aiReady)) return { ok: false, error: 'AI 未启用' }
  if (!items.length || !categories.length) return { ok: true, data: {} }

  const allowed = new Set(categories)
  const out: Record<number, string> = {}
  const chunkSize = 100
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize)
    const payload = JSON.stringify(
      chunk.map((it) => ({
        i: it.i,
        note: clip(it.note),
        counterparty: clip(it.counterparty),
        direction: it.direction === 'expense' ? '支出' : '收入',
        amount: (it.amount_cents / 100).toFixed(2),
      })),
    )
    const res = await withAiFailover(configs, async (cfg) => {
      const chatRes = await chat(cfg, [
        { role: 'system', content: SUGGEST_SYSTEM },
        { role: 'user', content: `分类清单：${categories.join('、')}\n流水：${payload}` },
      ])
      if (!chatRes.ok) return chatRes
      const parsed = extractJson(chatRes.data)
      const list = (parsed as { items?: unknown })?.items
      if (!Array.isArray(list)) return { ok: false, error: 'AI 输出格式不符合预期' }
      return { ok: true, data: list }
    })
    if (!res.ok) return res
    for (const item of res.data) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const i = Number(o.i)
      const name = str(o.category)
      if (!Number.isInteger(i) || !name) continue
      if (!allowed.has(name)) continue
      out[i] = name
    }
  }
  return { ok: true, data: out }
}

export type AiUtteranceItem = {
  date: string
  amount_cents: number
  direction: 'expense' | 'income'
  note: string
  category_name: string
  account_name: string
  source: string
  favor_contact: string
  favor_kind: '' | 'give' | 'receive'
  favor_occasion: string
}

const UTTERANCE_SYSTEM = `你是记账助手。用户用口语记了若干笔账，可能有多句。
只输出 JSON：{"items":[{"date":"YYYY-MM-DD","amount":35.5,"direction":"expense","note":"午饭","category":"餐饮","account":"","source":"原句","favor_contact":"","favor_kind":"","favor_occasion":""}]}
规则：
- 一句一笔。认不出金额的不要输出。
- amount 是人民币元，正数，最多两位小数。
- direction 只能是 expense 或 income。收到、工资、退款、报销是 income，其余默认 expense。随礼送出是 expense，收到礼金是 income。
- date 用 YYYY-MM-DD。用户说昨天、前天、今天时，按消息里给出的「今天」换算。没说日期就用今天。
- note 写成简短备注，不要整句照抄。
- category 必须从参考分类里选，且和方向一致；不确定就留空字符串。
- account 必须从参考账户里选；不确定就留空字符串。
- 随礼、礼金、份子、压岁钱、红包给人：favor_contact 写对方姓名（2到4个汉字），favor_kind 写 give 或 receive，favor_occasion 写结婚、满月、搬家、寿宴、升学、丧事、过年、生日之一，没有就留空。
- 微信、支付宝、美团、银行不是人名，不要写进 favor_contact。普通消费这三个字段都留空。
- source 填对应的原句。
- 不要编造金额。`

/** 把口语交给模型拆成流水。失败由调用方退回规则解析。 */
export async function aiParseUtterances(
  configs: AiConfig[],
  text: string,
  ctx: { today: string; categories: string[]; accounts: string[] },
): Promise<AiResult<AiUtteranceItem[]>> {
  if (!configs.some(aiReady)) return { ok: false, error: 'AI 未启用' }
  const clipped = text.trim().slice(0, 4000)
  if (!clipped) return { ok: true, data: [] }
  const reference = [
    `今天是 ${ctx.today}`,
    ctx.categories.length ? `参考分类：${ctx.categories.join('、')}` : '',
    ctx.accounts.length ? `参考账户：${ctx.accounts.join('、')}` : '',
    `原话：\n${clipped}`,
  ]
    .filter(Boolean)
    .join('\n')

  const res = await withAiFailover(configs, async (cfg) => {
    const chatRes = await chat(
      cfg,
      [
        { role: 'system', content: UTTERANCE_SYSTEM },
        { role: 'user', content: reference },
      ],
      { timeoutMs: 25_000 },
    )
    if (!chatRes.ok) return chatRes
    const parsed = extractJson(chatRes.data)
    const list = (parsed as { items?: unknown })?.items
    if (!Array.isArray(list)) return { ok: false, error: 'AI 输出格式不符合预期' }
    return { ok: true, data: list }
  })
  if (!res.ok) return res

  const out: AiUtteranceItem[] = []
  for (const item of res.data.slice(0, 50)) {
    const shaped = shapeUtterance(item, ctx.today)
    if (shaped) out.push(shaped)
  }
  if (!out.length) return { ok: false, error: 'AI 没有解析出可入账的句子' }
  return { ok: true, data: out }
}

function shapeUtterance(item: unknown, today: string): AiUtteranceItem | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const amount = parseAmountCents(typeof o.amount === 'number' ? o.amount : String(o.amount ?? ''))
  if (amount === null || amount === 0) return null
  const rawDate = o.date
  const date = rawDate instanceof Date ? parseDateYmd(rawDate) : parseDateYmd(String(rawDate ?? ''))
  const direction = o.direction === 'income' ? 'income' : 'expense'
  const favorKind = o.favor_kind === 'give' || o.favor_kind === 'receive' ? o.favor_kind : ''
  const note = str(o.note).slice(0, 80) || str(o.source).slice(0, 80)
  if (!note) return null
  return {
    date: date ?? (/^\d{4}-\d{2}-\d{2}$/.test(today) ? today : ''),
    amount_cents: Math.abs(amount),
    direction,
    note,
    category_name: str(o.category),
    account_name: str(o.account),
    source: str(o.source).slice(0, 200),
    favor_contact: str(o.favor_contact).slice(0, 8),
    favor_kind: favorKind,
    favor_occasion: str(o.favor_occasion).slice(0, 16),
  }
}

/** 连通性测试：最小请求，返回耗时与模型回显。 */
export async function testAi(cfg: AiConfig): Promise<AiResult<{ latencyMs: number; sample: string }>> {
  if (!aiReady(cfg)) return { ok: false, error: '请先填写 base_url、api_key、model 并启用' }
  const started = Date.now()
  const res = await chat(
    cfg,
    [
      { role: 'system', content: '只输出 JSON。' },
      { role: 'user', content: '回复 {"ok":true}' },
    ],
    { timeoutMs: 30_000 },
  )
  if (!res.ok) return res
  return { ok: true, data: { latencyMs: Date.now() - started, sample: res.data.slice(0, 120) } }
}

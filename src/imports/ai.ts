/**
 * AI 兜底：OpenAI 兼容的 chat/completions。
 *
 * 用途只有两个，且都在规则解析之后：
 *   1. 表格结构识别不出来时，把行丢给模型转成统一字段
 *   2. 给备注/对方建议分类（用户在预览页可改）
 *
 * 没配置 AI 时一切照常：规则解析先跑，AI 只是补位，失败也只降级不报错。
 */

import type { Db } from '../db/types.ts'
import { parseAmountCents, parseDateYmd, parseDirection, type Direction } from './values.ts'

export type AiConfig = {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  updatedAt?: number
}

/** AI 一次最多处理的行数与分块大小（成本与延迟的折中）。 */
export const AI_MAX_ROWS = 200
const AI_CHUNK = 50
const CELL_LIMIT = 60
const REQUEST_TIMEOUT_MS = 60_000

export const EMPTY_AI_CONFIG: AiConfig = { enabled: false, baseUrl: '', apiKey: '', model: '' }

export async function readAiConfig(db: Db): Promise<AiConfig> {
  const row = await db.first<{ enabled: number; base_url: string; api_key: string; model: string; updated_at: number }>(
    `SELECT enabled, base_url, api_key, model, updated_at FROM ai_settings WHERE id = 'default'`,
  )
  if (!row) return { ...EMPTY_AI_CONFIG }
  return {
    enabled: !!row.enabled,
    baseUrl: row.base_url ?? '',
    apiKey: row.api_key ?? '',
    model: row.model ?? '',
    updatedAt: Number(row.updated_at ?? 0),
  }
}

export function aiReady(cfg: AiConfig): boolean {
  return !!cfg.enabled && !!cfg.baseUrl.trim() && !!cfg.apiKey.trim() && !!cfg.model.trim()
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
  cfg: AiConfig,
  rows: string[][],
  ctx: { startRowNo: number; categories: string[]; accounts: string[] },
): Promise<AiResult<{ rows: AiParsedRow[]; truncated: boolean }>> {
  if (!aiReady(cfg)) return { ok: false, error: 'AI 未启用' }
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

    const res = await chat(cfg, [
      { role: 'system', content: PARSE_SYSTEM },
      { role: 'user', content: `${reference}\n\n表格行：\n${lines}` },
    ])
    if (!res.ok) return { ok: false, error: res.error }

    const parsed = extractJson(res.data)
    const list = (parsed as { rows?: unknown })?.rows
    if (!Array.isArray(list)) return { ok: false, error: 'AI 输出格式不符合预期' }
    for (const item of list) {
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
  cfg: AiConfig,
  items: SuggestItem[],
  categories: string[],
): Promise<AiResult<Record<number, string>>> {
  if (!aiReady(cfg)) return { ok: false, error: 'AI 未启用' }
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
    const res = await chat(cfg, [
      { role: 'system', content: SUGGEST_SYSTEM },
      { role: 'user', content: `分类清单：${categories.join('、')}\n流水：${payload}` },
    ])
    if (!res.ok) return { ok: false, error: res.error }
    const parsed = extractJson(res.data)
    const list = (parsed as { items?: unknown })?.items
    if (!Array.isArray(list)) continue
    for (const item of list) {
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

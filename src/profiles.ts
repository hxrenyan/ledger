/**
 * llm（账单解析）/ asr（语音识别）/ ocr（图片识别）共用 ai_profiles。
 * 按 kind 分开读写；同一 kind 内 sort_order 就是失败后的接力顺序。
 */

import type { Db, Stmt } from './db/types.ts'
import { badRequest } from './http.ts'
import { newId } from './seed.ts'

export type ProfileKind = 'llm' | 'asr' | 'ocr'

export type Profile = {
  id: string
  name: string
  enabled: boolean
  protocol: string
  baseUrl: string
  apiKey: string
  model: string
  sortOrder: number
  updatedAt: number
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

export function maskSecret(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

export async function readProfiles(db: Db, kind: ProfileKind): Promise<Profile[]> {
  const rows = await db.all<{
    id: string
    name: string
    enabled: number
    protocol: string
    base_url: string
    api_key: string
    model: string
    sort_order: number
    updated_at: number
  }>(
    `SELECT id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at
     FROM ai_profiles
     WHERE kind = ?
     ORDER BY sort_order ASC, updated_at ASC, id ASC`,
    [kind],
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    enabled: !!row.enabled,
    protocol: row.protocol ?? '',
    baseUrl: row.base_url ?? '',
    apiKey: row.api_key ?? '',
    model: row.model ?? '',
    sortOrder: Number(row.sort_order) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }))
}

/** 按数组顺序整表替换这一种 kind。空数组表示清空。 */
export async function replaceProfiles(
  db: Db,
  kind: ProfileKind,
  items: unknown,
  opts: { max: number; tooMany: string; modelMax: number; protocol: string },
): Promise<Profile[]> {
  if (!Array.isArray(items)) throw badRequest('请提供 items 数组')
  if (items.length > opts.max) throw badRequest(opts.tooMany)
  const existing = await readProfiles(db, kind)
  const byId = new Map(existing.map((item) => [item.id, item]))
  const seen = new Set<string>()
  const now = Date.now()
  const next: Profile[] = []

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
    const model = typeof item.model === 'string' ? item.model.trim().slice(0, opts.modelMax) : (prev?.model ?? '')
    let apiKey = prev?.apiKey ?? ''
    if (item.clear_key === true) apiKey = ''
    else if (typeof item.api_key === 'string' && item.api_key.trim()) apiKey = item.api_key.trim()

    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw badRequest(`第 ${index + 1} 套的 base_url 需以 http(s):// 开头`)
    if (enabled && (!baseUrl || !apiKey || !model)) {
      throw badRequest(`第 ${index + 1} 套要参与接力，需要同时填写 base_url、api_key、model`)
    }
    next.push({
      id,
      name,
      enabled,
      protocol: opts.protocol,
      baseUrl,
      apiKey,
      model,
      sortOrder: index,
      updatedAt: now,
    })
  })

  const stmts: Stmt[] = []
  for (const old of existing) {
    if (!seen.has(old.id)) stmts.push({ sql: `DELETE FROM ai_profiles WHERE kind = ? AND id = ?`, params: [kind, old.id] })
  }
  for (const row of next) {
    stmts.push({
      sql: `INSERT INTO ai_profiles (kind, id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, id) DO UPDATE SET
              name = excluded.name, enabled = excluded.enabled, protocol = excluded.protocol,
              base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model,
              sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
      params: [kind, row.id, row.name, row.enabled ? 1 : 0, row.protocol, row.baseUrl, row.apiKey, row.model, row.sortOrder, now],
    })
  }
  if (stmts.length) await db.batch(stmts)
  return readProfiles(db, kind)
}

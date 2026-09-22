/**
 * 语音识别：多套配置，按 sort_order 接力。
 *
 * 一套超时、HTTP 失败或没有文本，就换下一套。不是多选一。
 * protocol 目前只有 openai-audio（POST {base}/audio/transcriptions，multipart file+model），
 * 硅基流动的 XingChenASR 走这条。以后换别的协议只加分支，不必改表。
 */

import type { Db, Stmt } from '../db/types.ts'
import { badRequest } from '../http.ts'
import { newId } from '../seed.ts'

export const MAX_ASR_PROFILES = 8
export const DEFAULT_ASR_MODEL = 'XingChenAGI/XingChenASR-V3.2-Ultra'
export const DEFAULT_ASR_BASE = 'https://api.siliconflow.cn/v1'
export const ASR_PROTOCOL = 'openai-audio'
const REQUEST_TIMEOUT_MS = 60_000

export type AsrProfile = {
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

export type AudioPayload = {
  bytes: Uint8Array
  filename: string
  mime: string
}

export type AsrResult = { ok: true; text: string; profile: string } | { ok: false; error: string }

type SaveItem = {
  id?: unknown
  name?: unknown
  enabled?: unknown
  base_url?: unknown
  model?: unknown
  api_key?: unknown
  clear_key?: unknown
}

export function asrReady(profile: AsrProfile): boolean {
  return !!profile.enabled && !!profile.baseUrl.trim() && !!profile.apiKey.trim() && !!profile.model.trim()
}

export function profileLabel(profile: AsrProfile): string {
  return profile.name.trim() || profile.model.trim() || '未命名配置'
}

/** 支持 host、host/v1、以及完整 .../audio/transcriptions。 */
export function resolveTranscriptionEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/audio\/transcriptions$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/audio/transcriptions`
  return `${base}/v1/audio/transcriptions`
}

export async function readAsrProfiles(db: Db): Promise<AsrProfile[]> {
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
     FROM asr_profiles
     ORDER BY sort_order ASC, updated_at ASC, id ASC`,
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    enabled: !!row.enabled,
    protocol: row.protocol || ASR_PROTOCOL,
    baseUrl: row.base_url ?? '',
    apiKey: row.api_key ?? '',
    model: row.model ?? '',
    sortOrder: Number(row.sort_order) || 0,
    updatedAt: Number(row.updated_at) || 0,
  }))
}

export async function asrAvailable(db: Db): Promise<boolean> {
  const profiles = await readAsrProfiles(db)
  return profiles.some(asrReady)
}

/** 按数组顺序整表替换。空数组表示清空。数组下标就是接力顺序。 */
export async function replaceAsrProfiles(db: Db, items: unknown): Promise<AsrProfile[]> {
  if (!Array.isArray(items)) throw badRequest('请提供 items 数组')
  if (items.length > MAX_ASR_PROFILES) throw badRequest(`最多 ${MAX_ASR_PROFILES} 套语音配置`)
  const existing = await readAsrProfiles(db)
  const byId = new Map(existing.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const now = Date.now()
  const next: AsrProfile[] = []

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
    const model = typeof item.model === 'string' ? item.model.trim().slice(0, 120) : (prev?.model ?? '')
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
      protocol: ASR_PROTOCOL,
      baseUrl,
      apiKey,
      model,
      sortOrder: index,
      updatedAt: now,
    })
  })

  const stmts: Stmt[] = []
  for (const old of existing) {
    if (!seen.has(old.id)) stmts.push({ sql: `DELETE FROM asr_profiles WHERE id = ?`, params: [old.id] })
  }
  for (const row of next) {
    stmts.push({
      sql: `INSERT INTO asr_profiles (id, name, enabled, protocol, base_url, api_key, model, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, enabled = excluded.enabled, protocol = excluded.protocol,
              base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model,
              sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
      params: [row.id, row.name, row.enabled ? 1 : 0, row.protocol, row.baseUrl, row.apiKey, row.model, row.sortOrder, now],
    })
  }
  if (stmts.length) await db.batch(stmts)
  return readAsrProfiles(db)
}

export function toPublicAsr(profile: AsrProfile) {
  return {
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    protocol: profile.protocol,
    base_url: profile.baseUrl,
    model: profile.model,
    has_key: !!profile.apiKey,
    key_hint: maskKey(profile.apiKey),
    endpoint: profile.baseUrl ? resolveTranscriptionEndpoint(profile.baseUrl) : '',
    sort_order: profile.sortOrder,
    updated_at: profile.updatedAt,
  }
}

export async function transcribeChain(profiles: AsrProfile[], audio: AudioPayload): Promise<AsrResult> {
  const ready = profiles.filter(asrReady)
  if (!ready.length) return { ok: false, error: '没有可用的语音识别配置' }
  const errors: string[] = []
  for (const profile of ready) {
    const res = await transcribeOne(profile, audio)
    if (res.ok) return { ok: true, text: res.text, profile: profileLabel(profile) }
    errors.push(`${profileLabel(profile)}：${clip(res.error)}`)
  }
  return { ok: false, error: errors.join('；') }
}

export async function transcribeOne(
  profile: AsrProfile,
  audio: AudioPayload,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!asrReady({ ...profile, enabled: true })) return { ok: false, error: '配置不完整' }
  if (profile.protocol !== ASR_PROTOCOL) return { ok: false, error: `暂不支持协议 ${profile.protocol}` }
  const endpoint = resolveTranscriptionEndpoint(profile.baseUrl)
  if (!endpoint) return { ok: false, error: 'base_url 为空' }
  const form = new FormData()
  form.append('file', new File([audio.bytes], audio.filename || 'speech.webm', { type: audio.mime || 'application/octet-stream' }))
  form.append('model', profile.model)
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: /abort|timeout/i.test(msg) ? '请求超时' : `请求失败：${msg}` }
  }
  const body = await res.text().catch(() => '')
  if (!res.ok) return { ok: false, error: `返回 ${res.status}：${body.slice(0, 180) || '无内容'}` }
  try {
    const payload = JSON.parse(body) as { text?: unknown }
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) return { ok: false, error: '没有识别出文本' }
    return { ok: true, text }
  } catch {
    const text = body.trim()
    if (!text) return { ok: false, error: '返回不是文本' }
    return { ok: true, text: text.slice(0, 2000) }
  }
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

function clip(msg: string): string {
  const s = msg.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

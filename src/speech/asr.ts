/**
 * 语音识别：多套配置，按 sort_order 接力。
 *
 * 一套超时、HTTP 失败或没有文本，就换下一套。不是多选一。
 * protocol 目前只有 openai-audio（POST {base}/audio/transcriptions，multipart file+model），
 * 硅基流动的 XingChenASR 走这条。以后换别的协议只加分支，不必改表。
 */

import type { Db } from '../db/types.ts'
import { maskSecret, readProfiles, replaceProfiles, type Profile } from '../profiles.ts'

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

function toAsrProfile(row: Profile): AsrProfile {
  return { ...row, protocol: row.protocol || ASR_PROTOCOL }
}

export async function readAsrProfiles(db: Db): Promise<AsrProfile[]> {
  return (await readProfiles(db, 'asr')).map(toAsrProfile)
}

export async function asrAvailable(db: Db): Promise<boolean> {
  const profiles = await readAsrProfiles(db)
  return profiles.some(asrReady)
}

/** 按数组顺序整表替换。空数组表示清空。数组下标就是接力顺序。 */
export async function replaceAsrProfiles(db: Db, items: unknown): Promise<AsrProfile[]> {
  const saved = await replaceProfiles(db, 'asr', items, {
    max: MAX_ASR_PROFILES,
    tooMany: `最多 ${MAX_ASR_PROFILES} 套语音配置`,
    modelMax: 120,
    protocol: ASR_PROTOCOL,
  })
  return saved.map(toAsrProfile)
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
    key_hint: maskSecret(profile.apiKey),
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

function clip(msg: string): string {
  const s = msg.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

/**
 * 图片识别（拍照记账）：多套配置，按 sort_order 接力。
 *
 * 和语音识别同一套路：一套超时、HTTP 失败或没有文本，就换下一套。
 *
 * protocol 目前只有 openai-vision，即 OpenAI 兼容的 chat/completions 里塞
 * 一条 image_url（data URL）。硅基流动的 PaddleOCR-VL-1.5 走这条：
 * 它的官方调用方式是「只发图片、不发文字指令」，返回的是带版面标记的纯文本，
 * 所以这里不拼任何提示词 —— 结构化留给第二步（kind=llm 的票据文本解析）。
 *
 * 图片只在这次请求的内存里过一遍：不写 D1，也不进对象存储。
 */

import type { Db } from '../db/types.ts'
import { maskSecret, readProfiles, replaceProfiles, type Profile } from '../profiles.ts'

export const MAX_OCR_PROFILES = 8
export const DEFAULT_OCR_MODEL = 'PaddlePaddle/PaddleOCR-VL-1.5'
export const DEFAULT_OCR_BASE = 'https://api.siliconflow.cn/v1'
export const OCR_PROTOCOL = 'openai-vision'

/** 一次识别的上限。拍单据本来就不该慢，超了换下一套。 */
const REQUEST_TIMEOUT_MS = 90_000
/** 输出上限：一整页手写本可能很长，但没必要等它写满 16K。 */
const MAX_OUTPUT_TOKENS = 8192

export type OcrProfile = {
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

export type ImagePayload = {
  bytes: Uint8Array
  filename: string
  mime: string
}

export type OcrResult = { ok: true; text: string; profile: string } | { ok: false; error: string }

export function ocrReady(profile: OcrProfile): boolean {
  return !!profile.enabled && !!profile.baseUrl.trim() && !!profile.apiKey.trim() && !!profile.model.trim()
}

export function profileLabel(profile: OcrProfile): string {
  return profile.name.trim() || profile.model.trim() || '未命名配置'
}

/** 只认图片：接口层已经按分片类型挡过一次，这里是第二道。 */
export const IMAGE_MIME_ALLOW = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/heic']

export function isAllowedImageMime(mime: string): boolean {
  return IMAGE_MIME_ALLOW.indexOf(mime.trim().toLowerCase()) >= 0
}

/** base_url 归一化：支持 host、host/v1、以及完整 .../chat/completions。 */
export function resolveOcrEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

function toOcrProfile(row: Profile): OcrProfile {
  return { ...row, protocol: row.protocol || OCR_PROTOCOL }
}

export async function readOcrProfiles(db: Db): Promise<OcrProfile[]> {
  return (await readProfiles(db, 'ocr')).map(toOcrProfile)
}

export async function ocrAvailable(db: Db): Promise<boolean> {
  const profiles = await readOcrProfiles(db)
  return profiles.some(ocrReady)
}

/** 按数组顺序整表替换。空数组表示清空。数组下标就是接力顺序。 */
export async function replaceOcrProfiles(db: Db, items: unknown): Promise<OcrProfile[]> {
  const saved = await replaceProfiles(db, 'ocr', items, {
    max: MAX_OCR_PROFILES,
    tooMany: `最多 ${MAX_OCR_PROFILES} 套图片识别配置`,
    modelMax: 120,
    protocol: OCR_PROTOCOL,
  })
  return saved.map(toOcrProfile)
}

export function toPublicOcr(profile: OcrProfile) {
  return {
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    protocol: profile.protocol,
    base_url: profile.baseUrl,
    model: profile.model,
    has_key: !!profile.apiKey,
    key_hint: maskSecret(profile.apiKey),
    endpoint: profile.baseUrl ? resolveOcrEndpoint(profile.baseUrl) : '',
    sort_order: profile.sortOrder,
    updated_at: profile.updatedAt,
  }
}

/** Uint8Array → base64。分块转，整张图一次 fromCharCode 会爆栈。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

export function toDataUrl(image: ImagePayload): string {
  const mime = image.mime && isAllowedImageMime(image.mime) ? image.mime : 'image/jpeg'
  return `data:${mime};base64,${bytesToBase64(image.bytes)}`
}

/**
 * 收拾 OCR 输出里的版面标记。
 *
 * PaddleOCR-VL 用 <nl> 表示换行、<fcel>/<ecel>/... 表示表格单元格边界。
 * 这些标记对第二步的语言模型不但没用、还会干扰断句，所以在这里清掉。
 * 只动白名单里的标记，其余原样保留 —— 别把正文里正当的尖括号内容也删了。
 */
export function normalizeOcrText(raw: string): string {
  return raw
    .replace(/<nl>/gi, '\n')
    .replace(/<\/?(?:fcel|ecel|lcel|ucel|xcel)>/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function recognizeChain(profiles: OcrProfile[], image: ImagePayload): Promise<OcrResult> {
  const ready = profiles.filter(ocrReady)
  if (!ready.length) return { ok: false, error: '没有可用的图片识别配置' }
  const errors: string[] = []
  for (const profile of ready) {
    const res = await recognizeOne(profile, image)
    if (res.ok) return { ok: true, text: res.text, profile: profileLabel(profile) }
    errors.push(`${profileLabel(profile)}：${clip(res.error)}`)
  }
  return { ok: false, error: errors.join('；') }
}

export async function recognizeOne(
  profile: OcrProfile,
  image: ImagePayload,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!ocrReady({ ...profile, enabled: true })) return { ok: false, error: '配置不完整' }
  if (profile.protocol !== OCR_PROTOCOL) return { ok: false, error: `暂不支持协议 ${profile.protocol}` }
  const endpoint = resolveOcrEndpoint(profile.baseUrl)
  if (!endpoint) return { ok: false, error: 'base_url 为空' }

  // 只发图片、不发文字指令：PaddleOCR-VL 是这样训练的，
  // 多加一句「请提取 JSON」反而会让它跑偏。结构化交给第二步的语言模型。
  const body = {
    model: profile.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: toDataUrl(image), detail: 'high' },
          },
        ],
      },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    stream: false,
  }

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: /abort|timeout/i.test(msg) ? '请求超时' : `请求失败：${msg}` }
  }

  const raw = await res.text().catch(() => '')
  if (!res.ok) return { ok: false, error: `返回 ${res.status}：${raw.slice(0, 180) || '无内容'}` }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: '返回不是 JSON' }
  }
  const choice = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
  const content = choice?.message?.content
  const rawText = typeof content === 'string' ? content : ''
  const text = normalizeOcrText(rawText)
  if (!text) return { ok: false, error: '这张图里没有识别出文字' }
  return { ok: true, text: text.slice(0, 20000) }
}

function clip(msg: string): string {
  const s = msg.replace(/\s+/g, ' ').trim()
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

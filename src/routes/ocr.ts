import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, HttpError } from '../http.ts'
import {
  isAllowedImageMime,
  ocrAvailable,
  readOcrProfiles,
  recognizeChain,
  type ImagePayload,
} from '../ocr/vision.ts'

/** 和收据上传同一个量级：手机直出的照片最多两三兆，再大说明客户端没压缩。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
/** 先按字符串长度挡一道，避免为一个超长字段做无谓的解码。 */
const MAX_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES / 3) * 4) + 1024

export function registerOcrRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/ocr/status', async (c) => {
    return c.json({ available: await ocrAvailable(c.get('db')) })
  })

  /**
   * 认图。两种送法都收：
   *   - multipart/form-data 的 file 字段（直连时走这条，图片不膨胀）
   *   - application/json 的 { image_base64, mime }（走云函数时只有这条能过，
   *     因为 callFunction 只送 JSON）
   * 两条路进到同一个识别函数，语义完全一致。
   */
  app.post('/api/v1/ocr/scan', async (c) => {
    const image = await readImage(c.req.raw)
    const profiles = await readOcrProfiles(c.get('db'))
    const res = await recognizeChain(profiles, image)
    if (!res.ok) throw new HttpError(502, 'ocr_failed', res.error)
    return c.json({ text: res.text, profile: res.profile, chars: res.text.length })
  })
}

async function readImage(req: Request): Promise<ImagePayload> {
  const type = (req.headers.get('content-type') || '').toLowerCase()
  if (type.indexOf('application/json') === 0) return readImageJson(req)
  return readImageForm(req)
}

async function readImageForm(req: Request): Promise<ImagePayload> {
  const form = await req.formData().catch(() => null)
  if (!form) throw badRequest('请上传图片')
  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('请上传图片')
  return imageFromFile(file)
}

/**
 * 单个文件 → 图片负载（含类型与体积校验）。
 * 后台「测一套」也用它：那边自己要读 form 里的其它字段，所以不能再单独读一次 body。
 */
export async function imageFromFile(file: File): Promise<ImagePayload> {
  if (!file.size) throw badRequest('图片是空的')
  if (file.size > MAX_IMAGE_BYTES) throw badRequest('照片太大，请压缩后再试')
  const declared = (file.type || '').trim().toLowerCase()
  if (declared && !isAllowedImageMime(declared)) throw badRequest('只接受 JPG / PNG / WebP / BMP / HEIC 图片')
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    bytes: bytes,
    filename: file.name || 'photo',
    mime: declared || sniffMime(bytes) || 'image/jpeg',
  }
}

async function readImageJson(req: Request): Promise<ImagePayload> {
  const body = (await req.json().catch(() => null)) as { image_base64?: unknown; mime?: unknown } | null
  const raw = body && typeof body.image_base64 === 'string' ? body.image_base64.trim() : ''
  if (!raw) throw badRequest('请上传图片')
  if (raw.length > MAX_BASE64_CHARS) throw badRequest('照片太大，请压缩后再试')
  // 允许省略 data URL 前缀；有前缀就剥掉，别把它当图片内容解码。
  const pure = raw.replace(/^data:[^;,]*;base64,/i, '')
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(pure)
  } catch {
    throw badRequest('图片内容不是合法的 base64')
  }
  if (!bytes.length) throw badRequest('图片是空的')
  if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('照片太大，请压缩后再试')
  let mime = typeof body?.mime === 'string' ? body.mime.trim().toLowerCase() : ''
  if (!mime) mime = sniffMime(bytes) || 'image/jpeg'
  if (!isAllowedImageMime(mime)) throw badRequest('只接受 JPG / PNG / WebP / BMP / HEIC 图片')
  return { bytes: bytes, filename: 'photo', mime: mime }
}

function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** 客户端没给 mime 时按文件头猜，免得把 PNG 当 JPEG 报给模型。 */
function sniffMime(bytes: Uint8Array): string {
  if (bytes.length >= 8) {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    if (isPng) return 'image/png'
    const isWebp =
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    if (isWebp) return 'image/webp'
    const isBmp = bytes[0] === 0x42 && bytes[1] === 0x4d
    if (isBmp) return 'image/bmp'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return ''
}

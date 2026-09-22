import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, HttpError } from '../http.ts'
import { asrAvailable, readAsrProfiles, transcribeChain, type AudioPayload } from '../speech/asr.ts'

const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export function registerSpeechRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/speech/status', async (c) => {
    return c.json({ available: await asrAvailable(c.get('db')) })
  })

  app.post('/api/v1/speech/transcribe', async (c) => {
    // 音频只存在这次请求的内存里，转写完即丢。不写 D1，也不进对象存储。
    const form = await c.req.raw.formData().catch(() => null)
    if (!form) throw badRequest('请上传音频文件')
    const audio = await readAudio(form)
    const profiles = await readAsrProfiles(c.get('db'))
    const res = await transcribeChain(profiles, audio)
    if (!res.ok) throw new HttpError(502, 'asr_failed', res.error)
    return c.json({ text: res.text, profile: res.profile })
  })
}

export async function readAudio(form: FormData): Promise<AudioPayload> {
  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('请上传音频文件')
  if (!file.size) throw badRequest('音频是空的')
  if (file.size > MAX_AUDIO_BYTES) throw badRequest('音频超过 8MB')
  const mime = file.type || 'application/octet-stream'
  if (mime && !/^audio\/|^video\/webm$|^application\/octet-stream$/.test(mime)) {
    throw badRequest('只接受音频')
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name || 'speech.webm',
    mime,
  }
}

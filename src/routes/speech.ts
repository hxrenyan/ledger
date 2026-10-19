import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, HttpError } from '../http.ts'
import { asrAvailable, readAsrProfiles, transcribeChain, type AudioPayload } from '../speech/asr.ts'
import {
  assertWechatRecognition,
  chargeSpeech,
  getBalance,
  insufficient,
  isWechatUser,
  lackMessage,
  pointsForSeconds,
  recognitionRestricted,
  reserveCall,
  speechSeconds,
} from '../points/wallet.ts'

const MAX_AUDIO_BYTES = 2 * 1024 * 1024

export function registerSpeechRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/speech/status', async (c) => {
    const db = c.get('db')
    const limited = await recognitionRestricted(db)
    return c.json({
      available: await asrAvailable(db),
      allowed: !limited || (await isWechatUser(db, c.get('userId'))),
    })
  })

  app.post('/api/v1/speech/transcribe', async (c) => {
    // 音频只存在这次请求的内存里，转写完即丢。不写数据库，也不进对象存储。
    const form = await c.req.raw.formData().catch(() => null)
    if (!form) throw badRequest('请上传音频文件')
    const audio = await readAudio(form)
    const db = c.get('db')
    const userId = c.get('userId')
    const seconds = speechSeconds(audio.bytes.byteLength, form.get('duration_ms'))
    if (await recognitionRestricted(db)) {
      await assertWechatRecognition(db, userId)
      const cost = pointsForSeconds(seconds)
      const balance = await getBalance(db, userId)
      if (balance < cost) throw insufficient(await lackMessage(db, userId, cost, balance))
      // 余额够才计数。转写失败也占次数，但不扣积分。
      await reserveCall(db, userId, 'speech')
    }
    const profiles = await readAsrProfiles(db)
    const res = await transcribeChain(profiles, audio)
    if (!res.ok) throw new HttpError(502, 'asr_failed', res.error)
    // 没认出文字不算识别成功，不扣积分。调用次数在上传前已经记下。
    const points = res.text
      ? await chargeSpeech(db, userId, seconds)
      : { charged: 0, balance: await getBalance(db, userId) }
    return c.json({ text: res.text, profile: res.profile, points })
  })
}

export async function readAudio(form: FormData): Promise<AudioPayload> {
  const file = form.get('file')
  if (!(file instanceof File)) throw badRequest('请上传音频文件')
  if (!file.size) throw badRequest('音频是空的')
  if (file.size > MAX_AUDIO_BYTES) throw badRequest('音频超过 2MB')
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

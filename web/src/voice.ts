/**
 * 智能记账的共用逻辑：录音 / 拍照 → 识别 → 解析 → 核对 → 入账。
 *
 * 两条入口汇到同一个下游（与小程序 components/ai-panel 同构）：
 *   语音  录音 → /api/v1/speech/transcribe → 文字 → /api/v1/imports/utterances
 *   拍照  选图 → photo.prepare 压体积 → /api/v1/ocr/scan → 文字 → /api/v1/imports/receipt
 * 两条都 → 核对 → /api/v1/imports/commit。
 * 两个端点的提示词不同：口语一句一笔；票据要区分实付金额与余额、明细与合计。
 *
 * 音频、图片和识别出的原文都不落库，用完即丢。全屏页（pages/Speak.vue）和
 * 底部加号里的浮层（components/VoiceSheet.vue）共用这一份逻辑，区别只在 scope：
 * - 'tx'：所有能入账的行都记进流水；
 * - 'favor'：只记识别人情往来的行，其余成功行忽略。
 */
import { computed, ref } from 'vue'
import { api, type ImportCommitResult, type ImportPreviewRow } from './api.ts'
import { prepare } from './photo.ts'
import { countIgnored, isFavorRow, pickPayable, type VoiceScope } from './voiceRows.ts'

export { countIgnored, isFavorRow, pickPayable } from './voiceRows.ts'
export type { VoiceScope, VoiceRowLike } from './voiceRows.ts'

export function useVoice(scope: VoiceScope) {
  const spoken = ref('')
  const parsedText = ref('')
  const rows = ref<ImportPreviewRow[]>([])
  const speechOn = ref(false)
  const photoOn = ref(false)
  /** 这一轮从哪进来的：决定「正在认图 / 正在识别」的文案，也决定重解析打哪个端点。 */
  const mode = ref<'' | 'voice' | 'photo'>('')
  const recording = ref(false)
  const busy = ref(false)
  const phase = ref<'idle' | 'hear' | 'parse'>('idle')
  const err = ref('')
  const msg = ref('')
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let recordTimer = 0
  /** 页面 / 浮层关闭后置位，避免把已弃用的识别结果再写回来。 */
  let disposed = false

  /** 待入账的行：人情场景只取识别人情的行。 */
  const payable = computed(() => pickPayable(rows.value, scope))
  const importable = computed(() => payable.value.length)
  /** 人情浮层里被忽略的流水行条数。 */
  const ignored = computed(() => countIgnored(rows.value))
  const statusText = computed(() => {
    if (recording.value) return '正在听，再点一次结束'
    // 认图慢是当前服务商的常态（视觉模型排队，实测首 token 30~60 秒，见 src/ocr/vision.ts），
    // 所以文案要说清在等什么 —— 光一个「正在认图」会让人以为卡死了。
    if (phase.value === 'hear') return mode.value === 'photo' ? '正在认图，识别模型排队中，请稍等' : '正在识别'
    if (phase.value === 'parse') return '正在整理成账'
    if (msg.value) return msg.value
    // 提示语跟着可用入口走，免得出现「按住说话」但语音其实没配。
    if (!speechOn.value && !photoOn.value) return '识别服务还没配置，可以先打字'
    if (!speechOn.value) return '点相机拍一张小票或支付截图'
    if (!photoOn.value) return scope === 'favor' ? '点一下说：给张三结婚随了 500' : '点一下开始说'
    return scope === 'favor' ? '说一句，或拍一张收礼 / 随礼的截图' : '点麦克风说话，或点相机拍小票'
  })

  async function checkSpeech() {
    try {
      speechOn.value = (await api<{ available: boolean }>('/api/v1/speech/status')).available
    } catch {
      speechOn.value = false
    }
  }

  /** 图片识别（OCR）配没配是另一回事：后台可以只配语音、或只配认图。 */
  async function checkPhoto() {
    try {
      photoOn.value = (await api<{ available: boolean }>('/api/v1/ocr/status')).available
    } catch {
      photoOn.value = false
    }
  }

  function stopTracks() {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  /** 离开页面或关闭浮层时调用：停麦克风，并丢弃这次的识别结果。 */
  function release() {
    disposed = true
    mode.value = ''
    stopTracks()
    window.clearTimeout(recordTimer)
    if (recorder?.state === 'recording') recorder.stop()
  }

  async function toggleMic() {
    if (!speechOn.value || busy.value) return
    if (recording.value) {
      recorder?.stop()
      return
    }
    mode.value = 'voice'
    err.value = ''
    msg.value = ''
    const got = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
    if (!got) {
      err.value = '无法使用麦克风。请允许浏览器使用麦克风，并使用 https 打开。'
      return
    }
    stream = got
    const chunks: Blob[] = []
    const rec = new MediaRecorder(got)
    recorder = rec
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.onstop = async () => {
      stopTracks()
      recording.value = false
      window.clearTimeout(recordTimer)
      if (disposed) return
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      const fd = new FormData()
      fd.append('file', blob, 'speech.webm')
      phase.value = 'hear'
      busy.value = true
      try {
        const data = await api<{ text: string }>('/api/v1/speech/transcribe', { method: 'POST', body: fd })
        spoken.value = data.text
        await parseSpoken()
      } catch (e) {
        err.value = e instanceof Error ? e.message : '识别失败'
        phase.value = 'idle'
        busy.value = false
      }
    }
    rec.start()
    recording.value = true
    phase.value = 'hear'
    recordTimer = window.setTimeout(() => rec.stop(), 60_000)
  }

  async function parseSpoken() {
    if (!spoken.value.trim()) {
      phase.value = 'idle'
      busy.value = false
      return
    }
    busy.value = true
    phase.value = 'parse'
    err.value = ''
    msg.value = ''
    const photo = mode.value === 'photo'
    try {
      const data = await api<{ items: ImportPreviewRow[]; parser: 'ai' | 'rules' | 'none'; ai_error: string }>(
        photo ? '/api/v1/imports/receipt' : '/api/v1/imports/utterances',
        { method: 'POST', body: JSON.stringify({ text: spoken.value }) },
      )
      rows.value = data.items
      parsedText.value = spoken.value
      if (data.parser === 'none') {
        // 认出了字，但没配文本解析模型。原文就摆在上面的框里，改完还能再整理一次。
        err.value = data.ai_error || '认出了文字，但还没整理成流水'
      } else if (scope === 'favor' && !payable.value.length) {
        err.value = photo
          ? '这张里没看出人情往来，改一下上面的文字再试'
          : '没听出人情往来。可以说：给张三结婚随了 500，或收到李四礼金 200'
      } else if (!payable.value.length) {
        err.value = photo ? '没整理出能入账的行，改一下上面的文字再试' : '没听出能入账的句子，改一下再说一次'
      } else {
        msg.value = data.parser === 'ai' || !data.ai_error ? '核对后记入' : '已按规则整理，核对后记入'
      }
    } catch (e) {
      err.value = e instanceof Error ? e.message : '解析失败'
    } finally {
      phase.value = 'idle'
      busy.value = false
    }
  }

  /**
   * 拍照 / 选图记账：压体积 → 认图 → 把原文交给下游解析。
   *
   * 与语音那条路的差别只有「文字从哪来」——认完图之后走的是同一段核对与入账，
   * 所以这里把识别结果写进 spoken 再调 parseSpoken()，不另起一套流程。
   */
  async function pickPhoto(file: File) {
    if (busy.value || disposed) return
    mode.value = 'photo'
    err.value = ''
    msg.value = ''
    phase.value = 'hear'
    busy.value = true
    try {
      const shot = await prepare(file)
      const fd = new FormData()
      fd.append('file', shot.blob, shot.name)
      const res = await api<{ text: string }>('/api/v1/ocr/scan', { method: 'POST', body: fd })
      if (disposed) return
      const text = (res.text || '').trim()
      if (!text) {
        err.value = '这张没认出文字，靠近点重拍'
        phase.value = 'idle'
        busy.value = false
        return
      }
      spoken.value = text
      await parseSpoken()
    } catch (e) {
      if (disposed) return
      err.value = e instanceof Error ? e.message : '拍照识别失败'
      phase.value = 'idle'
      busy.value = false
    }
  }

  /** 成功返回提示文案，失败返回 null（错误写在 err 里）。 */
  async function commit(): Promise<string | null> {
    const payload = payable.value.map((r) => ({
      date: r.date,
      amount_cents: r.amount_cents,
      direction: r.direction,
      note: r.note,
      category_id: r.category_id,
      account_id: r.account_id,
      favor_contact: r.favor_contact,
      favor_kind: r.favor_kind,
      favor_occasion: r.favor_occasion,
    }))
    if (!payload.length) {
      err.value = scope === 'favor' ? '没有可记的人情' : '没有可入账的句子'
      return null
    }
    busy.value = true
    err.value = ''
    try {
      const data = await api<ImportCommitResult>('/api/v1/imports/commit', {
        method: 'POST',
        // 拍照进来的算通用票据来源，语音是 utterance（与小程序端保持一致）。
        body: JSON.stringify({
          source: mode.value === 'photo' ? 'generic' : 'utterance',
          filename: '',
          rows: payload,
        }),
      })
      spoken.value = ''
      parsedText.value = ''
      rows.value = []
      mode.value = ''
      const gifts = data.gifts ? `，人情 ${data.gifts} 笔` : ''
      msg.value = `已记入 ${data.imported} 笔${gifts}`
      return msg.value
    } catch (e) {
      err.value = e instanceof Error ? e.message : '入账失败'
      return null
    } finally {
      busy.value = false
    }
  }

  return {
    spoken,
    parsedText,
    rows,
    speechOn,
    photoOn,
    mode,
    recording,
    busy,
    err,
    msg,
    importable,
    ignored,
    statusText,
    isFavorRow,
    checkSpeech,
    checkPhoto,
    release,
    toggleMic,
    parseSpoken,
    pickPhoto,
    commit,
  }
}

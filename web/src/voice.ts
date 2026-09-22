/**
 * 语音记账的共用逻辑：录音 → 识别 → 解析 → 核对 → 入账。
 *
 * 录音和原文都不落库，识别完即丢；解析走 /api/v1/imports/utterances，
 * 入账走 /api/v1/imports/commit。全屏页（pages/Speak.vue）和底部加号里的
 * 浮层（components/VoiceSheet.vue）共用这一份逻辑，区别只在 scope：
 * - 'tx'：所有能入账的行都记进流水；
 * - 'favor'：只记识别人情往来的行，其余成功行忽略。
 */
import { computed, ref } from 'vue'
import { api, type ImportCommitResult, type ImportPreviewRow } from './api.ts'
import { countIgnored, isFavorRow, pickPayable, type VoiceScope } from './voiceRows.ts'

export { countIgnored, isFavorRow, pickPayable } from './voiceRows.ts'
export type { VoiceScope, VoiceRowLike } from './voiceRows.ts'

export function useVoice(scope: VoiceScope) {
  const spoken = ref('')
  const parsedText = ref('')
  const rows = ref<ImportPreviewRow[]>([])
  const speechOn = ref(false)
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
    if (!speechOn.value) return '语音还没配置，可以先打字'
    if (recording.value) return '正在听，再点一次结束'
    if (phase.value === 'hear') return '正在识别'
    if (phase.value === 'parse') return '正在整理成账'
    if (msg.value) return msg.value
    return scope === 'favor' ? '点一下说：给张三结婚随了 500' : '点一下开始说'
  })

  async function checkSpeech() {
    try {
      speechOn.value = (await api<{ available: boolean }>('/api/v1/speech/status')).available
    } catch {
      speechOn.value = false
    }
  }

  function stopTracks() {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
  }

  /** 离开页面或关闭浮层时调用：停麦克风，并丢弃这次的识别结果。 */
  function release() {
    disposed = true
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
    try {
      const data = await api<{ items: ImportPreviewRow[]; parser: 'ai' | 'rules'; ai_error: string }>(
        '/api/v1/imports/utterances',
        { method: 'POST', body: JSON.stringify({ text: spoken.value }) },
      )
      rows.value = data.items
      parsedText.value = spoken.value
      if (scope === 'favor' && !payable.value.length) {
        err.value = '没听出人情往来。可以说：给张三结婚随了 500，或收到李四礼金 200'
      } else if (!payable.value.length) {
        err.value = '没听出能入账的句子，改一下再说一次'
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
        body: JSON.stringify({ source: 'utterance', filename: '', rows: payload }),
      })
      spoken.value = ''
      parsedText.value = ''
      rows.value = []
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
    recording,
    busy,
    err,
    msg,
    importable,
    ignored,
    statusText,
    isFavorRow,
    checkSpeech,
    release,
    toggleMic,
    parseSpoken,
    commit,
  }
}

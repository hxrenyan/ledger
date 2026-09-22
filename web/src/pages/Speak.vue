<script setup lang="ts">
/**
 * 语音 / 自然语言记账。
 * 录音只在当次请求里转成文字，不保存音频，也不保存原文。确认后才写入流水或人情。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type ImportCommitResult, type ImportPreviewRow } from '../api.ts'
import { formatYuan } from '../money.ts'

const router = useRouter()
const spoken = ref('')
const rows = ref<ImportPreviewRow[]>([])
const speechOn = ref(false)
const recording = ref(false)
const busy = ref(false)
const err = ref('')
const msg = ref('')
let recorder: MediaRecorder | null = null
let recordTimer = 0

const importable = () => rows.value.filter((r) => r.status === 'ok' && r.direction !== 'skip').length

onMounted(async () => {
  try {
    speechOn.value = (await api<{ available: boolean }>('/api/v1/speech/status')).available
  } catch {
    speechOn.value = false
  }
})

async function toggleMic() {
  if (!speechOn.value || busy.value) return
  if (recording.value) {
    recorder?.stop()
    return
  }
  err.value = ''
  msg.value = ''
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
  if (!stream) {
    err.value = '无法使用麦克风。请允许浏览器使用麦克风，并使用 https 打开。'
    return
  }
  const chunks: Blob[] = []
  const rec = new MediaRecorder(stream)
  recorder = rec
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  rec.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop())
    recording.value = false
    window.clearTimeout(recordTimer)
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
    const fd = new FormData()
    fd.append('file', blob, 'speech.webm')
    busy.value = true
    try {
      const data = await api<{ text: string; profile: string }>('/api/v1/speech/transcribe', { method: 'POST', body: fd })
      spoken.value = spoken.value ? `${spoken.value}\n${data.text}` : data.text
      msg.value = `已识别（${data.profile}）。确认文字后点解析。`
    } catch (e2) {
      err.value = e2 instanceof Error ? e2.message : '识别失败'
    } finally {
      busy.value = false
    }
  }
  rec.start()
  recording.value = true
  recordTimer = window.setTimeout(() => rec.stop(), 60_000)
}

async function parseSpoken() {
  if (!spoken.value.trim()) return
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const data = await api<{ items: ImportPreviewRow[] }>('/api/v1/imports/utterances', {
      method: 'POST',
      body: JSON.stringify({ text: spoken.value }),
    })
    rows.value = data.items
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '解析失败'
  } finally {
    busy.value = false
  }
}

async function commitSpoken() {
  const payload = rows.value
    .filter((r) => r.status === 'ok' && r.direction !== 'skip')
    .map((r) => ({
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
    err.value = '没有可入账的句子'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const data = await api<ImportCommitResult>('/api/v1/imports/commit', {
      method: 'POST',
      body: JSON.stringify({ source: 'utterance', filename: '', rows: payload }),
    })
    spoken.value = ''
    rows.value = []
    const gifts = data.gifts ? `，人情 ${data.gifts} 笔` : ''
    msg.value = `已记入 ${data.imported} 笔${gifts}`
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '入账失败'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" type="button" @click="router.back()">←</button>
      <h1 style="margin:0">语音录入</h1>
    </div>
    <p class="muted">说一句话，或直接打字。录音和原文都不保存，确认后才入账。</p>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="muted">{{ msg }}</p>

    <div class="card">
      <button class="btn" type="button" :disabled="busy || !speechOn" @click="toggleMic">
        {{ recording ? '停止录音' : speechOn ? '按住说话（点一下开始）' : '语音未配置' }}
      </button>
      <p v-if="!speechOn" class="muted">请先在管理后台「语音识别」里配好硅基流动或其他识别接口。</p>
      <p v-else-if="recording" class="muted">正在听，最长 60 秒。再说一次按钮即可停止。</p>
      <div class="field">
        <span>识别结果，可改</span>
        <textarea v-model="spoken" rows="4" placeholder="例如：昨天午饭 35；给张三结婚随了 500"></textarea>
      </div>
      <button class="btn" type="button" :disabled="busy || !spoken.trim()" @click="parseSpoken">解析</button>
    </div>

    <div v-if="rows.length" class="card" style="margin-top:12px">
      <div v-for="r in rows" :key="r.row" class="row" style="display:block">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <div>
            <div>{{ r.status === 'skip' ? r.reason : r.note }}</div>
            <div class="muted" v-if="r.status === 'ok'">
              {{ r.date }} · {{ r.category_name || '未分类' }} · {{ r.account_name || '未选账户' }}
              <template v-if="r.favor_contact"> · 人情 {{ r.favor_kind === 'give' ? '送出' : '收入' }} {{ r.favor_contact }} {{ r.favor_occasion }}</template>
            </div>
          </div>
          <div v-if="r.status === 'ok'" class="amount" :class="r.direction === 'expense' ? 'expense' : 'income'">
            {{ r.direction === 'expense' ? '-' : '+' }}{{ formatYuan(r.amount_cents) }}
          </div>
        </div>
      </div>
      <button class="btn" type="button" style="margin-top:12px" :disabled="busy || !importable()" @click="commitSpoken">
        {{ busy ? '入账中…' : `记入 ${importable()} 笔` }}
      </button>
    </div>
  </div>
</template>

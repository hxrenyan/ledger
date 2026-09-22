<script setup lang="ts">
/**
 * 语音录入：先识别成文字，再用 AI 拆成流水，确认后才入账。
 * 录音和原文都不保存。没配 AI 时退回规则解析。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type ImportCommitResult, type ImportPreviewRow } from '../api.ts'
import { formatYuan } from '../money.ts'

const router = useRouter()
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
let recordTimer = 0

const importable = () => rows.value.filter((r) => r.status === 'ok' && r.direction !== 'skip').length
const statusText = computed(() => {
  if (!speechOn.value) return '语音还没配置，可以先打字'
  if (recording.value) return '正在听，再点一次结束'
  if (phase.value === 'hear') return '正在识别'
  if (phase.value === 'parse') return '正在整理成账'
  if (msg.value) return msg.value
  return '点一下开始说'
})

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
    phase.value = 'hear'
    busy.value = true
    try {
      const data = await api<{ text: string }>('/api/v1/speech/transcribe', { method: 'POST', body: fd })
      spoken.value = data.text
      await parseSpoken()
    } catch (e2) {
      err.value = e2 instanceof Error ? e2.message : '识别失败'
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
    msg.value = data.parser === 'ai' || !data.ai_error ? '核对后记入' : '已按规则整理，核对后记入'
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '解析失败'
  } finally {
    phase.value = 'idle'
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
    parsedText.value = ''
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

    <div class="speak-hero">
      <button class="mic" type="button" :class="{ on: recording }" :disabled="busy || !speechOn" @click="toggleMic">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
        </svg>
      </button>
      <p class="speak-status">{{ statusText }}</p>
    </div>

    <p v-if="err" class="err">{{ err }}</p>

    <div class="card speak-card">
      <div class="speak-label">
        <span>说的话，可以改</span>
        <button
          v-if="spoken.trim() && spoken !== parsedText"
          class="text-btn"
          type="button"
          :disabled="busy"
          @click="parseSpoken"
        >重新整理</button>
      </div>
      <textarea v-model="spoken" rows="3" placeholder="昨天午饭 35，给张三结婚随了 500"></textarea>
    </div>

    <div v-if="rows.length" class="card" style="margin-top:12px">
      <div v-for="r in rows" :key="r.row" class="row">
        <div>
          <div>{{ r.status === 'ok' ? r.note : r.reason }}</div>
          <div class="muted" v-if="r.status === 'ok'">
            {{ r.date }} · {{ r.category_name || '未分类' }} · {{ r.account_name || '未选账户' }}
            <template v-if="r.favor_contact"> · {{ r.favor_contact }} {{ r.favor_occasion }}</template>
          </div>
        </div>
        <div v-if="r.status === 'ok'" class="amount" :class="r.direction === 'expense' ? 'expense' : 'income'">
          {{ r.direction === 'expense' ? '-' : '+' }}{{ formatYuan(r.amount_cents) }}
        </div>
      </div>
      <button class="btn" type="button" style="margin-top:8px" :disabled="busy || !importable()" @click="commitSpoken">
        {{ busy ? '记入中…' : `记入 ${importable()} 笔` }}
      </button>
    </div>
  </div>
</template>

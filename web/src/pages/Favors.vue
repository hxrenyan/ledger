<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import LedgerName from '../components/LedgerName.vue'
import { api, type ImportCommitResult, type ImportPreviewRow } from '../api.ts'
import { formatYuan } from '../money.ts'
import { occurredAtToDate } from '@server/time.ts'

type Gift = {
  id: string
  contact_id: string
  contact_name: string
  kind: 'give' | 'receive'
  amount_cents: number
  occasion: string
  occurred_at: number
  note: string
}

const router = useRouter()
const items = ref<Gift[]>([])
const q = ref('')
const err = ref('')
const msg = ref('')
const spoken = ref('')
const parsedText = ref('')
const rows = ref<ImportPreviewRow[]>([])
const speechOn = ref(false)
const recording = ref(false)
const busy = ref(false)
let recorder: MediaRecorder | null = null
let recordTimer = 0

const favorRows = computed(() =>
  rows.value.filter((r) => r.status === 'ok' && r.favor_contact && (r.favor_kind === 'give' || r.favor_kind === 'receive')),
)

const visible = computed(() => {
  const s = q.value.trim()
  if (!s) return items.value
  return items.value.filter(
    (g) => g.contact_name.includes(s) || g.occasion.includes(s) || (g.note || '').includes(s),
  )
})

const totals = computed(() => {
  let given = 0
  let received = 0
  for (const g of visible.value) {
    if (g.kind === 'give') given += g.amount_cents
    else received += g.amount_cents
  }
  return { given, received }
})

const grouped = computed(() => {
  const map = new Map<string, Gift[]>()
  for (const g of visible.value) {
    const d = occurredAtToDate(g.occurred_at)
    const arr = map.get(d) ?? []
    arr.push(g)
    map.set(d, arr)
  }
  return [...map.entries()]
})

async function load() {
  err.value = ''
  try {
    items.value = (await api<{ items: Gift[] }>('/api/v1/gifts')).items
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

onMounted(async () => {
  await load()
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
      const data = await api<{ text: string }>('/api/v1/speech/transcribe', { method: 'POST', body: fd })
      spoken.value = data.text
      await parseSpoken()
    } catch (e2) {
      err.value = e2 instanceof Error ? e2.message : '识别失败'
      busy.value = false
    }
  }
  rec.start()
  recording.value = true
  recordTimer = window.setTimeout(() => rec.stop(), 60_000)
}

async function parseSpoken() {
  if (!spoken.value.trim()) {
    busy.value = false
    return
  }
  busy.value = true
  err.value = ''
  msg.value = ''
  try {
    const data = await api<{ items: ImportPreviewRow[]; parser: 'ai' | 'rules'; ai_error: string }>(
      '/api/v1/imports/utterances',
      { method: 'POST', body: JSON.stringify({ text: spoken.value }) },
    )
    rows.value = data.items
    parsedText.value = spoken.value
    if (!favorRows.value.length) {
      err.value = '没听出人情往来。可以说：给张三结婚随了 500，或收到李四礼金 200'
    } else {
      msg.value = data.parser === 'ai' ? '已识别为人情，核对后记入。' : '已用规则识别为人情，核对后记入。'
    }
  } catch (e2) {
    err.value = e2 instanceof Error ? e2.message : '解析失败'
  } finally {
    busy.value = false
  }
}

async function commitSpoken() {
  const payload = favorRows.value.map((r) => ({
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
    err.value = '没有可记的人情'
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
    msg.value = `已记入人情 ${data.gifts ?? payload.length} 笔`
    await load()
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
      <h1>人情往来</h1>
      <LedgerName />
      <router-link to="/favors/people">联系人</router-link>
    </div>
    <div class="summary">
      <div class="card"><div class="k">送出</div><div class="v expense">{{ formatYuan(totals.given) }}</div></div>
      <div class="card"><div class="k">收入</div><div class="v income">{{ formatYuan(totals.received) }}</div></div>
    </div>
    <div class="card" style="margin-bottom: 12px">
      <div class="inline">
        <button class="btn" type="button" :disabled="busy || !speechOn" @click="toggleMic">
          {{ recording ? '停止' : speechOn ? '说话记人情' : '语音未配置' }}
        </button>
        <button class="btn ghost" type="button" @click="router.push('/favors/new')">手写</button>
      </div>
      <p v-if="!speechOn" class="muted">可先打字。麦克风要在管理后台「语音识别」里配好。</p>
      <p v-else-if="recording" class="muted">正在听，再点一次停止。</p>
      <div class="field" style="margin-top: 12px">
        <span>可以说：给张三结婚随了 500</span>
        <textarea v-model="spoken" rows="2" placeholder="收到李四礼金 200"></textarea>
      </div>
      <button
        v-if="spoken.trim() && spoken !== parsedText"
        class="btn ghost"
        type="button"
        :disabled="busy"
        @click="parseSpoken"
      >解析</button>
      <div v-for="r in favorRows" :key="r.row" class="row" style="display:block">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <div>
            <div>{{ r.favor_contact }} · {{ r.favor_occasion || (r.favor_kind === 'give' ? '送出' : '收入') }}</div>
            <div class="muted">{{ r.date }} · {{ r.note }}</div>
          </div>
          <div class="amount" :class="r.favor_kind === 'give' ? 'expense' : 'income'">
            {{ r.favor_kind === 'give' ? '-' : '+' }}{{ formatYuan(r.amount_cents) }}
          </div>
        </div>
      </div>
      <button v-if="favorRows.length" class="btn" type="button" style="margin-top: 12px" :disabled="busy" @click="commitSpoken">
        {{ busy ? '记入中…' : `记入 ${favorRows.length} 笔人情` }}
      </button>
    </div>
    <div class="card" style="margin-bottom: 12px; padding: 10px 12px">
      <input v-model="q" placeholder="搜姓名 / 事由" class="bare" />
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <div v-if="!visible.length" class="card muted">还没有往来。可以说一句，或点上面的「手写」。</div>
    <div v-for="[day, rows] in grouped" :key="day" class="card" style="margin-bottom: 12px">
      <div class="muted">{{ day }}</div>
      <div class="row" v-for="g in rows" :key="g.id" @click="router.push(`/favors/gift/${g.id}`)">
        <div>
          <div>{{ g.contact_name }} · {{ g.occasion || (g.kind === 'give' ? '送出' : '收入') }}</div>
          <div class="muted">{{ g.note || (g.kind === 'give' ? '送出' : '收入') }}</div>
        </div>
        <div class="amount" :class="g.kind === 'give' ? 'expense' : 'income'">
          {{ g.kind === 'give' ? '-' : '+' }}{{ formatYuan(g.amount_cents) }}
        </div>
      </div>
    </div>
  </div>
</template>

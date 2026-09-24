<script setup lang="ts">
/**
 * 底部加号里的智能记账浮层：就地录音 / 拍照、识别、核对、入账，不离开当前页面。
 * 逻辑与全屏页 pages/Speak.vue 共用 useVoice，只有 scope 不同。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useVoice, type VoiceScope } from '../voice.ts'
import ShotButton from './ShotButton.vue'

const props = defineProps<{ scope: VoiceScope }>()
const emit = defineEmits<{ close: []; done: [string] }>()

const {
  spoken, parsedText, rows, accounts, categories, speechOn, photoOn, mode, recording, busy, err, ignored, importable,
  statusText, checkSpeech, checkPhoto, release, toggleMic, parseSpoken, pickPhoto, commit,
} = useVoice(props.scope)

const title = computed(() => (props.scope === 'favor' ? '记人情' : '记一笔'))
const placeholder = computed(() =>
  props.scope === 'favor'
    ? '给张三结婚随了 500'
    : '昨天午饭 35，给张三结婚随了 500',
)
/** 拍照进来时框里装的是认出的文字，标题得跟着换，不然像在让你改「说的话」。 */
const textLabel = computed(() => (mode.value === 'photo' ? '认出的文字，可以改' : '说的话，可以改'))
/** 人情场景也展示未识别出姓名的行，用户可以在这里补上后再保存。 */
const displayRows = computed(() => rows.value)

function setDirection(row: (typeof rows.value)[number], direction: 'expense' | 'income') {
  row.direction = direction
  const category = categories.value.find((item) => item.kind === direction)
  row.category_id = category?.id ?? null
  row.category_name = category?.name ?? ''
  if (props.scope === 'favor' && row.favor_contact.trim()) {
    row.favor_kind = direction === 'income' ? 'receive' : 'give'
  }
}

function setFavorContact(row: (typeof rows.value)[number], value: string) {
  row.favor_contact = value
  if (value.trim() && (row.direction === 'expense' || row.direction === 'income')) {
    row.favor_kind = row.direction === 'income' ? 'receive' : 'give'
  } else if (!value.trim()) {
    row.favor_kind = ''
  }
}

let alive = true
onMounted(() => {
  checkSpeech()
  checkPhoto()
})
onUnmounted(() => {
  alive = false
  // 录音中关闭浮层时要停麦克风，也不再转写
  release()
})

async function onCommit() {
  const ok = await commit()
  if (ok && alive) emit('done', ok)
}
</script>

<template>
  <div class="voice-sheet">
    <div class="voice-head">
      <strong>{{ title }}</strong>
      <button class="text-btn" type="button" @click="emit('close')">关闭</button>
    </div>

    <div class="voice-mic">
      <div class="mic-row">
        <button
          v-if="speechOn"
          class="mic mic-sm"
          type="button"
          :class="{ on: recording }"
          :disabled="busy"
          aria-label="点击开始说话"
          @click="toggleMic"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
            <path d="M6 11a6 6 0 0 0 12 0M12 17v3" />
          </svg>
        </button>
        <ShotButton v-if="photoOn" :disabled="busy" @picked="pickPhoto" />
      </div>
      <p class="speak-status">{{ statusText }}</p>
    </div>

    <p v-if="err" class="err">{{ err }}</p>

    <div class="card speak-card">
      <div class="speak-label">
        <span>{{ textLabel }}</span>
        <button
          v-if="spoken.trim() && spoken !== parsedText"
          class="text-btn"
          type="button"
          :disabled="busy"
          @click="parseSpoken"
        >重新整理</button>
      </div>
      <textarea v-model="spoken" rows="3" :placeholder="placeholder"></textarea>
    </div>

    <div v-if="displayRows.length" class="voice-rows voice-edit-list">
      <div class="voice-edit-title">识别结果（可直接修改）</div>
      <div v-for="r in displayRows" :key="r.row" class="voice-edit-row">
        <div v-if="r.status !== 'ok'" class="err">第 {{ r.row }} 行：{{ r.reason || '未识别，可补全后保存' }}</div>
        <div class="voice-edit-head">
          <div class="kind two">
            <button type="button" :class="{ on: r.direction === 'expense', expense: true }" @click="setDirection(r, 'expense')">支出</button>
            <button type="button" :class="{ on: r.direction === 'income', income: true }" @click="setDirection(r, 'income')">收入</button>
          </div>
          <input v-model="r.amount_text" class="voice-edit-amount" inputmode="decimal" placeholder="金额" aria-label="金额（元）" />
        </div>
        <div class="voice-edit-fields">
          <label><span>日期</span><input v-model="r.date" type="date" /></label>
          <label><span>分类</span><select v-model.number="r.category_id"><option :value="null">未分类</option><option v-for="c in categories.filter((x) => x.kind === r.direction)" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
          <label><span>账户</span><select v-model.number="r.account_id"><option :value="null">未选账户</option><option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option></select></label>
          <label><span>对方 / 姓名</span><input v-model="r.favor_contact" placeholder="人情往来可填写" @input="setFavorContact(r, r.favor_contact)" /></label>
          <label><span>备注</span><input v-model="r.note" placeholder="请输入备注" /></label>
        </div>
      </div>
    </div>
    <p v-if="scope === 'favor' && ignored" class="muted">
      另有 {{ ignored }} 条没算作人情，已忽略；要记流水请到明细页的加号。
    </p>

    <button class="btn" type="button" :disabled="busy || !importable" @click="onCommit">
      {{ busy ? '记入中…' : scope === 'favor' ? `记入 ${importable} 笔人情` : `记入 ${importable} 笔` }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 底部加号里的智能记账浮层：就地录音 / 拍照、识别、核对、入账，不离开当前页面。
 * 逻辑与全屏页 pages/Speak.vue 共用 useVoice，只有 scope 不同。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { formatYuan } from '../money.ts'
import { useVoice, type VoiceScope } from '../voice.ts'
import ShotButton from './ShotButton.vue'

const props = defineProps<{ scope: VoiceScope }>()
const emit = defineEmits<{ close: []; done: [string] }>()

const {
  spoken, parsedText, rows, speechOn, photoOn, mode, recording, busy, err, ignored, importable,
  statusText, isFavorRow, checkSpeech, checkPhoto, release, toggleMic, parseSpoken, pickPhoto, commit,
} = useVoice(props.scope)

const title = computed(() => (props.scope === 'favor' ? '记人情' : '记一笔'))
const placeholder = computed(() =>
  props.scope === 'favor'
    ? '给张三结婚随了 500'
    : '昨天午饭 35，给张三结婚随了 500',
)
/** 拍照进来时框里装的是认出的文字，标题得跟着换，不然像在让你改「说的话」。 */
const textLabel = computed(() => (mode.value === 'photo' ? '认出的文字，可以改' : '说的话，可以改'))
/** 人情场景只看识别人情的行，流水行由下面一句提示带过。 */
const displayRows = computed(() => (props.scope === 'tx' ? rows.value : rows.value.filter(isFavorRow)))

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

    <div v-if="displayRows.length" class="voice-rows">
      <div v-for="r in displayRows" :key="r.row" class="row">
        <div>
          <div>{{ r.status === 'ok' ? r.note : r.reason }}</div>
          <div v-if="r.status === 'ok'" class="muted">
            {{ r.date }} · {{ r.category_name || '未分类' }} · {{ r.account_name || '未选账户' }}
            <template v-if="r.favor_contact"> · {{ r.favor_contact }} {{ r.favor_occasion }}</template>
          </div>
        </div>
        <div v-if="r.status === 'ok'" class="amount" :class="r.direction === 'expense' ? 'expense' : 'income'">
          {{ r.direction === 'expense' ? '-' : '+' }}{{ formatYuan(r.amount_cents) }}
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

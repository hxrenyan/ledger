<script setup lang="ts">
/**
 * 语音录入（全屏版）：识别 → AI 解析 → 核对 → 入账。
 * 底部加号里的浮层（components/VoiceSheet.vue）共用同一套逻辑。
 */
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { formatYuan } from '../money.ts'
import { useVoice } from '../voice.ts'

const router = useRouter()
const {
  spoken, parsedText, rows, speechOn, recording, busy, err, importable, statusText,
  checkSpeech, release, toggleMic, parseSpoken, commit,
} = useVoice('tx')

onMounted(checkSpeech)
// 离开页面时停麦克风，别让录音一直开着
onUnmounted(release)
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
      <button class="btn" type="button" style="margin-top:8px" :disabled="busy || !importable" @click="commit">
        {{ busy ? '记入中…' : `记入 ${importable} 笔` }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 智能记账（全屏版）：说话或拍照 → 识别 → AI 解析 → 核对 → 入账。
 * 底部加号里的浮层（components/VoiceSheet.vue）共用同一套逻辑。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useVoice } from '../voice.ts'
import ShotButton from '../components/ShotButton.vue'

const router = useRouter()
const {
  spoken, parsedText, rows, accounts, categories, speechOn, photoOn, mode, recording, busy, err, importable, statusText,
  checkSpeech, checkPhoto, release, toggleMic, parseSpoken, pickPhoto, commit,
} = useVoice('tx')

function setDirection(row: (typeof rows.value)[number], direction: 'expense' | 'income') {
  row.direction = direction
  const category = categories.value.find((item) => item.kind === direction)
  row.category_id = category?.id ?? null
  row.category_name = category?.name ?? ''
}

/** 拍照进来时框里装的是认出的文字，标题得跟着换。 */
const textLabel = computed(() => (mode.value === 'photo' ? '认出的文字，可以改' : '说的话，可以改'))

onMounted(() => {
  checkSpeech()
  checkPhoto()
})
// 离开页面时停麦克风，别让录音一直开着
onUnmounted(release)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" type="button" @click="router.back()">←</button>
      <h1 style="margin:0">智能记账</h1>
    </div>

    <div class="speak-hero">
      <div class="mic-row">
        <button
          v-if="speechOn"
          class="mic"
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
        <ShotButton v-if="photoOn" size="lg" :disabled="busy" @picked="pickPhoto" />
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
      <textarea v-model="spoken" rows="3" placeholder="昨天午饭 35，给张三结婚随了 500"></textarea>
    </div>

    <div v-if="rows.length" class="card voice-edit-list" style="margin-top:12px">
      <div class="voice-edit-title">识别结果（可直接修改）</div>
      <div v-for="r in rows" :key="r.row" class="voice-edit-row">
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
          <label><span>对方 / 姓名</span><input v-model="r.favor_contact" placeholder="可留空" /></label>
          <label><span>备注</span><input v-model="r.note" placeholder="请输入备注" /></label>
        </div>
        <div class="muted voice-edit-meta">分类：{{ r.category_name || '未分类' }} · 账户：{{ r.account_name || '未选账户' }}</div>
      </div>
      <button class="btn" type="button" style="margin-top:8px" :disabled="busy || !importable" @click="commit">
        {{ busy ? '记入中…' : `记入 ${importable} 笔` }}
      </button>
    </div>
  </div>
</template>

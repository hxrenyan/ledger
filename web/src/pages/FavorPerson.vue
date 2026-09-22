<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api.ts'
import { formatYuan } from '../money.ts'
import { onDataChange } from '../refresh.ts'
import { occurredAtToDate } from '@server/time.ts'

type Gift = {
  id: string
  contact_id: string
  kind: 'give' | 'receive'
  amount_cents: number
  occasion: string
  occurred_at: number
  note: string
}

const route = useRoute()
const router = useRouter()
const contactId = computed(() => route.params.id as string)
const name = ref('')
const items = ref<Gift[]>([])
const err = ref('')

const given = computed(() => items.value.filter((g) => g.kind === 'give').reduce((s, g) => s + g.amount_cents, 0))
const received = computed(() => items.value.filter((g) => g.kind === 'receive').reduce((s, g) => s + g.amount_cents, 0))
const lastRecv = computed(() => items.value.find((g) => g.kind === 'receive') ?? null)

async function load() {
  err.value = ''
  try {
    const contacts = await api<{ items: { id: string; name: string }[] }>('/api/v1/contacts')
    name.value = contacts.items.find((c) => c.id === contactId.value)?.name ?? '往来'
    items.value = (await api<{ items: Gift[] }>(`/api/v1/gifts?contact_id=${contactId.value}`)).items
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

watch(() => route.params.id, load, { immediate: true })
// 加号浮层里记完人情后，这里跟着刷新
onDataChange(load)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.push('/favors/people')">‹</button>
      <h1>{{ name }}</h1>
    </div>
    <div class="summary">
      <div class="card"><div class="k">送出</div><div class="v expense">{{ formatYuan(given) }}</div></div>
      <div class="card"><div class="k">收入</div><div class="v income">{{ formatYuan(received) }}</div></div>
    </div>
    <div v-if="lastRecv" class="card" style="margin-bottom: 12px">
      <div class="muted">还礼参考</div>
      <div>上次对方随了 {{ formatYuan(lastRecv.amount_cents) }}（{{ lastRecv.occasion || '人情' }}）</div>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <div v-if="!items.length" class="card muted">还没有和这个人的往来</div>
    <div v-else class="card">
      <div class="row" v-for="g in items" :key="g.id" @click="router.push(`/favors/gift/${g.id}`)">
        <div>
          <div>{{ g.occasion || (g.kind === 'give' ? '送出' : '收入') }}</div>
          <div class="muted">{{ occurredAtToDate(g.occurred_at) }} {{ g.note }}</div>
        </div>
        <div class="amount" :class="g.kind === 'give' ? 'expense' : 'income'">
          {{ g.kind === 'give' ? '-' : '+' }}{{ formatYuan(g.amount_cents) }}
        </div>
      </div>
    </div>
  </div>
</template>

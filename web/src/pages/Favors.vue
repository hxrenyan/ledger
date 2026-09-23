<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import LedgerName from '../components/LedgerName.vue'
import { api } from '../api.ts'
import { formatYuan } from '../money.ts'
import { onDataChange } from '../refresh.ts'
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

// 底部加号浮层里记完人情后，这里要跟着刷新
onDataChange(load)
onMounted(load)
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
    <div class="card" style="margin-bottom: 12px; padding: 10px 12px">
      <input v-model="q" placeholder="搜姓名 / 事由" class="bare" />
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <div v-if="!visible.length" class="card muted">还没有往来。点下面的「+」可以说一句、或拍一张收礼 / 随礼的截图，也可以手写记一笔。</div>
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

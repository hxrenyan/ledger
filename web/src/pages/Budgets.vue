<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Category } from '../api.ts'

const router = useRouter()
import { formatYuan, yuanInputToCents } from '../money.ts'
import { addMonth, shanghaiMonth } from '@server/time.ts'

type Budget = { id: string; category_id: string | null; amount_cents: number }
type CatStat = { category_id: string; name: string; kind: string; amount_cents: number; budget_cents: number }

const month = ref(shanghaiMonth())
const totalYuan = ref('')
const catYuan = ref<Record<string, string>>({})
const cats = ref<Category[]>([])
const budgets = ref<Budget[]>([])
const stats = ref<{ expense_cents: number; budget_cents: number; by_category: CatStat[] }>({
  expense_cents: 0,
  budget_cents: 0,
  by_category: [],
})
const err = ref('')

const expenseCats = computed(() => cats.value.filter((c) => c.kind === 'expense' && !c.archived))

function label(m: string) {
  const [y, mo] = m.split('-')
  return `${y}年${Number(mo)}月`
}

async function load() {
  err.value = ''
  const [b, s, c] = await Promise.all([
    api<{ items: Budget[] }>(`/api/v1/budgets?month=${month.value}`),
    api<typeof stats.value>(`/api/v1/stats/monthly?month=${month.value}`),
    api<{ items: Category[] }>('/api/v1/categories'),
  ])
  budgets.value = b.items
  stats.value = s
  cats.value = c.items
  const total = b.items.find((x) => !x.category_id)
  totalYuan.value = total ? formatYuan(total.amount_cents) : ''
  const next: Record<string, string> = {}
  for (const x of b.items) {
    if (x.category_id) next[x.category_id] = formatYuan(x.amount_cents)
  }
  catYuan.value = next
}

async function saveTotal() {
  const cents = yuanInputToCents(totalYuan.value)
  if (!cents) {
    err.value = '请输入月预算'
    return
  }
  await api('/api/v1/budgets', {
    method: 'PUT',
    body: JSON.stringify({ month: month.value, amount_cents: cents, category_id: '' }),
  })
  await load()
}

async function saveCat(id: string) {
  const cents = yuanInputToCents(catYuan.value[id] ?? '')
  if (!cents) return
  await api('/api/v1/budgets', {
    method: 'PUT',
    body: JSON.stringify({ month: month.value, amount_cents: cents, category_id: id }),
  })
  await load()
}

onMounted(load)
watch(month, load)
</script>

<template>
  <div class="page">
    <div class="head">
      <button class="back" @click="router.push('/me')">‹</button>
      <h1>预算</h1>
    </div>
    <div class="month" style="margin-bottom: 12px">
      <button @click="month = addMonth(month, -1)">‹</button>
      <strong>{{ label(month) }}</strong>
      <button @click="month = addMonth(month, 1)">›</button>
    </div>
    <div class="card" style="margin-bottom: 12px">
      <div class="muted">本月已花 {{ formatYuan(stats.expense_cents) }}</div>
      <label class="field" style="margin-top: 12px"><span>月总预算（元）</span><input v-model="totalYuan" inputmode="decimal" /></label>
      <p v-if="err" class="err">{{ err }}</p>
      <button class="btn" @click="saveTotal">保存总预算</button>
    </div>
    <div class="card">
      <h2>分类预算</h2>
      <div class="row" v-for="c in expenseCats" :key="c.id">
        <div style="flex:1;margin-right:8px">
          <div>{{ c.name }}</div>
          <div class="muted">已花 {{ formatYuan(stats.by_category.find(x => x.category_id === c.id)?.amount_cents ?? 0) }}</div>
        </div>
        <input v-model="catYuan[c.id]" inputmode="decimal" placeholder="0.00" style="width:88px;border:1px solid var(--line);border-radius:10px;padding:8px" />
        <button class="btn ghost" style="width:auto;margin-left:8px" @click="saveCat(c.id)">存</button>
      </div>
    </div>
  </div>
</template>

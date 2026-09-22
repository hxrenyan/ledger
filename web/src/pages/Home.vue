<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import LedgerName from '../components/LedgerName.vue'
import { api, type Account, type Category, type Tx } from '../api.ts'
import { formatYuan } from '../money.ts'
import { addMonth, daysInShanghaiMonth, occurredAtToDate, shanghaiDate, shanghaiMonth } from '@server/time.ts'
import { onDataChange } from '../refresh.ts'
import { useSession } from '../stores/session.ts'

type Overview = {
  income_cents: number
  expense_cents: number
  budget_cents: number
  budget_used_cents: number
  year_income_cents: number
  year_expense_cents: number
  net_worth_cents: number
  by_category: { category_id: string; name: string; kind: string; amount_cents: number }[]
  trend: { month: string; income_cents: number; expense_cents: number }[]
}

const router = useRouter()
const session = useSession()
const tab = ref<'list' | 'cal' | 'chart'>('list')
const month = ref(shanghaiMonth())
const q = ref('')
const calDay = ref(shanghaiDate())
const filterCat = ref('')
const filterAcc = ref('')
const items = ref<Tx[]>([])
const cats = ref<Category[]>([])
const accounts = ref<Account[]>([])
const stats = ref<Overview>({
  income_cents: 0,
  expense_cents: 0,
  budget_cents: 0,
  budget_used_cents: 0,
  year_income_cents: 0,
  year_expense_cents: 0,
  net_worth_cents: 0,
  by_category: [],
  trend: [],
})
const err = ref('')

const catMap = computed(() => Object.fromEntries(cats.value.map((c) => [c.id, c.name])))
const accMap = computed(() => Object.fromEntries(accounts.value.map((a) => [a.id, a.name])))
const budgetPct = computed(() => {
  if (!stats.value.budget_cents) return 0
  return Math.min(100, Math.round((stats.value.budget_used_cents / stats.value.budget_cents) * 100))
})
const maxTrend = computed(() => Math.max(1, ...stats.value.trend.flatMap((t) => [t.income_cents, t.expense_cents])))
const maxCat = computed(() => Math.max(1, ...stats.value.by_category.filter((c) => c.kind === 'expense').map((c) => c.amount_cents)))

const byDay = computed(() => {
  const set = new Set<string>()
  for (const t of items.value) set.add(occurredAtToDate(t.occurred_at))
  return set
})

const calCells = computed(() => {
  const [y, m] = month.value.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const pad = (first.getUTCDay() + 6) % 7
  const days = daysInShanghaiMonth(month.value)
  const cells: (number | null)[] = [...Array(pad).fill(null)]
  for (let d = 1; d <= days; d++) cells.push(d)
  while (cells.length % 7) cells.push(null)
  return cells
})

const filtered = computed(() =>
  items.value.filter((t) => {
    if (filterCat.value && t.category_id !== filterCat.value) return false
    if (filterAcc.value && t.account_id !== filterAcc.value && t.to_account_id !== filterAcc.value) return false
    return true
  }),
)

const dayItems = computed(() =>
  filtered.value.filter((t) => occurredAtToDate(t.occurred_at) === calDay.value),
)

const grouped = computed(() => {
  const map = new Map<string, Tx[]>()
  for (const t of filtered.value) {
    const d = occurredAtToDate(t.occurred_at)
    const arr = map.get(d) ?? []
    arr.push(t)
    map.set(d, arr)
  }
  return [...map.entries()].map(([d, rows]) => ({
    d,
    rows,
    income: rows.reduce((s, t) => s + (t.kind === 'income' && !t.excluded ? t.amount_cents : 0), 0),
    expense: rows.reduce((s, t) => s + (t.kind === 'expense' && !t.excluded ? t.amount_cents : 0), 0),
  }))
})

function titleOf(t: Tx) {
  if (t.kind === 'transfer') return `${accMap.value[t.account_id] ?? '账户'} → ${accMap.value[t.to_account_id ?? ''] ?? '账户'}`
  return catMap.value[t.category_id ?? ''] || '未分类'
}

function ymd(d: number) {
  return `${month.value}-${String(d).padStart(2, '0')}`
}

function label(m: string) {
  const [y, mo] = m.split('-')
  return `${y}年${Number(mo)}月`
}

function syncCalDay() {
  const today = shanghaiDate()
  calDay.value = today.startsWith(month.value) ? today : `${month.value}-01`
}

async function load() {
  err.value = ''
  try {
    await api('/api/v1/recurrences/run', { method: 'POST' }).catch(() => null)
    const qs = new URLSearchParams({ month: month.value })
    if (q.value.trim()) qs.set('q', q.value.trim())
    const [tx, st, cs, acc] = await Promise.all([
      api<{ items: Tx[] }>(`/api/v1/transactions?${qs}`),
      api<Overview>(`/api/v1/stats/overview?month=${month.value}`),
      api<{ items: Category[] }>('/api/v1/categories'),
      api<{ items: Account[]; net_cents: number }>('/api/v1/accounts'),
    ])
    items.value = tx.items
    stats.value = st
    cats.value = cs.items
    accounts.value = acc.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

onMounted(load)
// 加号浮层里语音记完账后，这里跟着刷新
onDataChange(load)
watch([month, () => session.ledgerId], () => {
  syncCalDay()
  load()
})
</script>

<template>
  <div class="page">
    <div class="head">
      <h1>明细</h1>
      <LedgerName />
    </div>
    <div class="month">
      <button @click="month = addMonth(month, -1)">‹</button>
      <strong>{{ label(month) }}</strong>
      <button @click="month = addMonth(month, 1)">›</button>
    </div>
    <div class="summary">
      <div class="card"><div class="k">收入</div><div class="v income">{{ formatYuan(stats.income_cents) }}</div></div>
      <div class="card"><div class="k">支出</div><div class="v expense">{{ formatYuan(stats.expense_cents) }}</div></div>
    </div>
    <div class="muted" style="margin: -8px 0 12px">净资产 {{ formatYuan(stats.net_worth_cents) }} · 今年净 {{ formatYuan(stats.year_income_cents - stats.year_expense_cents) }}</div>
    <div v-if="stats.budget_cents" class="card" style="margin-bottom: 12px">
      <div class="muted">月预算 {{ formatYuan(stats.budget_used_cents) }} / {{ formatYuan(stats.budget_cents) }}</div>
      <div class="bar" :class="{ over: stats.budget_used_cents > stats.budget_cents }" style="margin-top: 8px">
        <i :style="{ width: budgetPct + '%' }"></i>
      </div>
    </div>
    <div class="tabs">
      <button :class="{ on: tab === 'list' }" @click="tab = 'list'">流水</button>
      <button :class="{ on: tab === 'cal' }" @click="tab = 'cal'; syncCalDay()">日历</button>
      <button :class="{ on: tab === 'chart' }" @click="tab = 'chart'">统计</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <template v-if="tab === 'list'">
      <div class="card" style="margin-bottom: 12px; padding: 10px 12px">
        <input v-model="q" class="bare" placeholder="搜备注" @keyup.enter="load" />
        <div class="filters">
          <select v-model="filterAcc">
            <option value="">全部账户</option>
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
          <select v-model="filterCat">
            <option value="">全部分类</option>
            <option v-for="c in cats.filter(x => !x.archived)" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
      </div>
      <div v-if="!grouped.length" class="card muted">这个月还没有记录</div>
      <div v-for="g in grouped" :key="g.d" class="card" style="margin-bottom: 12px">
        <div class="day-h">
          <span>{{ g.d }}</span>
          <span class="muted">
            <span v-if="g.income" class="income">+{{ formatYuan(g.income) }}</span>
            <span v-if="g.expense" class="expense">-{{ formatYuan(g.expense) }}</span>
          </span>
        </div>
        <div class="row" v-for="t in g.rows" :key="t.id" @click="router.push(`/tx/${t.id}`)">
          <div>
            <div>{{ titleOf(t) }} <span v-if="t.excluded" class="muted">不计入</span></div>
            <div class="muted">{{ t.note || (t.kind === 'income' ? '收入' : t.kind === 'transfer' ? '转账' : '支出') }}</div>
          </div>
          <div class="amount" :class="t.kind">
            {{ t.kind === 'expense' ? '-' : t.kind === 'income' ? '+' : '' }}{{ formatYuan(t.amount_cents) }}
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'cal'">
      <div class="cal">
        <span v-for="w in ['一','二','三','四','五','六','日']" :key="w" class="muted">{{ w }}</span>
        <button
          v-for="(d, i) in calCells"
          :key="i"
          class="cal-d"
          :class="{ on: d && ymd(d) === calDay, has: d && byDay.has(ymd(d)) }"
          :disabled="!d"
          @click="d && (calDay = ymd(d))"
        >{{ d || '' }}</button>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="muted">{{ calDay }}</div>
        <div v-if="!dayItems.length" class="muted">这一天没有记录</div>
        <div class="row" v-for="t in dayItems" :key="t.id" @click="router.push(`/tx/${t.id}`)">
          <div>{{ titleOf(t) }}</div>
          <div class="amount" :class="t.kind">{{ formatYuan(t.amount_cents) }}</div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="card" style="margin-bottom: 12px">
        <h2>近 6 个月</h2>
        <div v-for="t in stats.trend" :key="t.month" class="trend">
          <span class="muted">{{ t.month.slice(5) }}</span>
          <div class="trend-bars">
            <i class="income" :style="{ width: (t.income_cents / maxTrend * 100) + '%' }"></i>
            <i class="expense" :style="{ width: (t.expense_cents / maxTrend * 100) + '%' }"></i>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>本月分类</h2>
        <div v-for="c in stats.by_category.filter(x => x.kind === 'expense')" :key="c.category_id" class="row">
          <div>{{ c.name }}</div>
          <div class="amount expense">{{ formatYuan(c.amount_cents) }}</div>
        </div>
        <div v-for="c in stats.by_category.filter(x => x.kind === 'expense')" :key="c.category_id + 'b'" class="bar" style="margin-bottom: 8px">
          <i :style="{ width: (c.amount_cents / maxCat * 100) + '%' }"></i>
        </div>
      </div>
    </template>
  </div>
</template>

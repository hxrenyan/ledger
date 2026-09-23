<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import LedgerName from '../components/LedgerName.vue'
import MonthNav from '../components/MonthNav.vue'
import { api, type Account, type Category, type Tx } from '../api.ts'
import { formatYuan } from '../money.ts'
import { daysInShanghaiMonth, occurredAtToDate, shanghaiDate, shanghaiMonth } from '@server/time.ts'

/** occurred_at（毫秒）→ 上海时区的 HH:mm，流水行的次要文案用。 */
function clockOf(ms: number) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16)
}

/** '2026-09-23' → '9月23日 周三'，日分组与日历选中日的标题。 */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function dayLabel(d: string) {
  const p = d.split('-').map(Number)
  const w = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()
  return `${p[1]}月${p[2]}日 ${WEEK[w]}`
}
import { onDataChange } from '../refresh.ts'
import { useSession } from '../stores/session.ts'

type CategoryStat = { category_id: string; name: string; kind: string; amount_cents: number; budget_cents: number }
type Overview = {
  income_cents: number
  expense_cents: number
  budget_cents: number
  budget_used_cents: number
  year_income_cents: number
  year_expense_cents: number
  year_net_cents: number
  net_worth_cents: number
  by_category: CategoryStat[]
  trend: { month: string; income_cents: number; expense_cents: number }[]
}

const router = useRouter()
const session = useSession()
const tab = ref<'list' | 'cal' | 'chart'>('list')
const month = ref(shanghaiMonth())
const q = ref('')
const calDay = ref<string | null>(shanghaiDate())
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
  year_net_cents: 0,
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
const expenseCats = computed(() => stats.value.by_category.filter((c) => c.kind === 'expense' && c.amount_cents > 0))
const incomeCats = computed(() => stats.value.by_category.filter((c) => c.kind === 'income' && c.amount_cents > 0))
const expenseTotal = computed(() => expenseCats.value.reduce((s, c) => s + c.amount_cents, 0))
const trendExpense = computed(() => stats.value.trend.reduce((s, t) => s + t.expense_cents, 0))
const trendIncome = computed(() => stats.value.trend.reduce((s, t) => s + t.income_cents, 0))
const netCents = computed(() => stats.value.income_cents - stats.value.expense_cents)
const netText = computed(() => {
  const n = netCents.value
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${formatYuan(Math.abs(n))}`
})
const hasData = computed(() => stats.value.income_cents > 0 || stats.value.expense_cents > 0)
const monthAvgExpense = computed(() => Math.round(trendExpense.value / 6))
const monthAvgIncome = computed(() => Math.round(trendIncome.value / 6))
/** 本月已过天数，用来算日均；看历史月份时按整月算。 */
const daysElapsed = computed(() => {
  const days = daysInShanghaiMonth(month.value)
  if (month.value !== shanghaiMonth()) return days
  return Math.max(1, Number(shanghaiDate().slice(8, 10)))
})
const dailyExpense = computed(() => Math.round(stats.value.expense_cents / daysElapsed.value))

/** 柱状图高度：按 6 个月里的最大值归一；非零值给最小高度，免得看不见。 */
function barPct(v: number) {
  if (!v) return 0
  return Math.max(4, Math.round((v / maxTrend.value) * 100))
}
function sharePct(amount: number, total: number) {
  if (!total) return 0
  return Math.round((amount / total) * 100)
}
/** 有分类预算就按预算进度画，否则按占本月支出的比例画。 */
function catPct(c: CategoryStat) {
  if (c.budget_cents > 0) return Math.min(100, sharePct(c.amount_cents, c.budget_cents))
  return sharePct(c.amount_cents, expenseTotal.value)
}
function catOver(c: CategoryStat) {
  return c.budget_cents > 0 && c.amount_cents > c.budget_cents
}

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

/** 切月由 MonthNav 派发；连带清选中日、重拉数据（与小程序 home 同一决定）。 */
function onMonthChange(m: string) {
  month.value = m
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
// 加号浮层里智能记账记完后，这里跟着刷新
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
    <MonthNav :month="month" @change="onMonthChange" />
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
      <div v-if="!grouped.length" class="card muted">这个月还没有记录，点下面的「+」记一笔</div>
      <div v-for="g in grouped" :key="g.d" class="card" style="margin-bottom: 12px">
        <div class="day-h">
          <span>{{ dayLabel(g.d) }}</span>
          <span class="muted">
            <span v-if="g.income" class="income">+{{ formatYuan(g.income) }}</span>
            <span v-if="g.expense" class="expense">-{{ formatYuan(g.expense) }}</span>
          </span>
        </div>
        <div class="row" v-for="t in g.rows" :key="t.id" @click="router.push(`/tx/${t.id}`)">
          <div>
            <div>{{ titleOf(t) }} <span v-if="t.excluded" class="muted">不计入</span></div>
            <div class="muted">
              {{ accMap[t.account_id] || '账户' }}<template v-if="t.to_account_id"> → {{ accMap[t.to_account_id] || '账户' }}</template>
              · {{ clockOf(t.occurred_at) }}<template v-if="t.note"> · {{ t.note }}</template>
            </div>
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
      <div v-if="calDay" class="card" style="margin-top: 12px">
        <div class="day-h">
          <span>{{ dayLabel(calDay) }}</span>
          <button class="text-btn" type="button" @click="calDay = null">收起</button>
        </div>
        <div v-if="!dayItems.length" class="muted">这一天没有记录</div>
        <div class="row" v-for="t in dayItems" :key="t.id" @click="router.push(`/tx/${t.id}`)">
          <div>
            <div>{{ titleOf(t) }}</div>
            <div class="muted">{{ accMap[t.account_id] || '账户' }} · {{ clockOf(t.occurred_at) }}<template v-if="t.note"> · {{ t.note }}</template></div>
          </div>
          <div class="amount" :class="t.kind">{{ formatYuan(t.amount_cents) }}</div>
        </div>
      </div>
    </template>

    <template v-else>
      <div v-if="!hasData" class="card muted">{{ label(month) }}还没有记录，记一笔就能看到统计。</div>
      <template v-else>
        <div class="card stat-hero">
          <div class="stat-line">
            <span>结余</span>
            <span>日均支出 {{ formatYuan(dailyExpense) }}</span>
          </div>
          <div class="stat-net" :class="netCents >= 0 ? 'income' : 'expense'">{{ netText }}</div>
          <div class="stat-line">
            <span>收入 {{ formatYuan(stats.income_cents) }} · 支出 {{ formatYuan(stats.expense_cents) }}</span>
            <span>已过 {{ daysElapsed }} 天</span>
          </div>
        </div>

        <div class="card" style="margin-bottom: 12px">
          <div class="stat-h">
            <h2 style="margin:0">近 6 个月</h2>
            <span class="muted">月均支出 {{ formatYuan(monthAvgExpense) }}</span>
          </div>
          <div class="legend">
            <span><i class="dot income"></i>收入 {{ formatYuan(monthAvgIncome) }}/月</span>
            <span><i class="dot expense"></i>支出 {{ formatYuan(monthAvgExpense) }}/月</span>
          </div>
          <div class="chart">
            <div
              v-for="t in stats.trend"
              :key="t.month"
              class="chart-col"
              :class="{ on: t.month === month }"
            >
              <div class="chart-bars">
                <i class="income" :style="{ height: barPct(t.income_cents) + '%' }"></i>
                <i class="expense" :style="{ height: barPct(t.expense_cents) + '%' }"></i>
              </div>
              <span class="chart-x">{{ Number(t.month.slice(5)) }}月</span>
            </div>
          </div>
          <p class="muted stat-foot">
            近 6 个月收入 {{ formatYuan(trendIncome) }} · 支出 {{ formatYuan(trendExpense) }} · 结余
            {{ formatYuan(trendIncome - trendExpense) }}
          </p>
        </div>

        <div class="card">
          <div class="stat-h">
            <h2 style="margin:0">支出排行</h2>
            <span class="muted">合计 {{ formatYuan(expenseTotal) }}</span>
          </div>
          <p v-if="!expenseCats.length" class="muted">本月还没有支出。</p>
          <div v-for="c in expenseCats" :key="c.category_id" class="cat">
            <div class="cat-top">
              <span class="cat-name">{{ c.name }}</span>
              <span class="amount expense">{{ formatYuan(c.amount_cents) }}</span>
            </div>
            <div class="bar" :class="[c.budget_cents ? 'budget' : 'share', { over: catOver(c) }]">
              <i :style="{ width: catPct(c) + '%' }"></i>
            </div>
            <div class="cat-note">
              <template v-if="c.budget_cents">
                预算 {{ formatYuan(c.budget_cents) }} ·
                <template v-if="catOver(c)">
                  <b class="expense">超支 {{ formatYuan(c.amount_cents - c.budget_cents) }}</b>
                </template>
                <template v-else>已用 {{ sharePct(c.amount_cents, c.budget_cents) }}%</template>
              </template>
              <template v-else>占本月支出 {{ sharePct(c.amount_cents, expenseTotal) }}%</template>
            </div>
          </div>
        </div>

        <div v-if="incomeCats.length" class="card" style="margin-top: 12px">
          <div class="stat-h">
            <h2 style="margin:0">收入来源</h2>
            <span class="muted">合计 {{ formatYuan(stats.income_cents) }}</span>
          </div>
          <div v-for="c in incomeCats" :key="c.category_id" class="cat">
            <div class="cat-top">
              <span class="cat-name">{{ c.name }}</span>
              <span class="amount income">{{ formatYuan(c.amount_cents) }}</span>
            </div>
            <div class="bar income">
              <i :style="{ width: sharePct(c.amount_cents, stats.income_cents) + '%' }"></i>
            </div>
            <div class="cat-note">占收入 {{ sharePct(c.amount_cents, stats.income_cents) }}%</div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

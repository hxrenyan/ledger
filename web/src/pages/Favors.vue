<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MonthNav from '../components/MonthNav.vue'
import { api } from '../api.ts'
import { formatYuan } from '../money.ts'
import { onDataChange } from '../refresh.ts'
import { occurredAtToDate, shanghaiMonth } from '@server/time.ts'

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
type Contact = {
  id: string
  name: string
  relation: string
  archived: boolean
  given_cents: number
  received_cents: number
  net_cents: number
}

/**
 * 人情往来（tab），布局与小程序 pages/favors 同构：
 * 三列汇总（送出 / 收到 / 差额）→ 页内 tabs（往来记录 / 联系人）。
 * 往来记录按月筛（GET /gifts 是全量，月份在本地过滤）；联系人那一栏是全量的，
 * 跟月份没关系 —— 所以 MonthNav 只挂在往来记录那一栏。
 */
const router = useRouter()
const tab = ref<'gifts' | 'contacts'>('gifts')
const month = ref(shanghaiMonth())
const q = ref('')
const gifts = ref<Gift[]>([])
const contacts = ref<Contact[]>([])
const err = ref('')

/** 月份 + 搜索的本地过滤；汇总也按这份算（与小程序 applyFilter 同一决定）。 */
const visible = computed(() => {
  const s = q.value.trim()
  return gifts.value.filter((g) => {
    if (occurredAtToDate(g.occurred_at).slice(0, 7) !== month.value) return false
    if (s && !g.contact_name.includes(s) && !g.occasion.includes(s) && !(g.note || '').includes(s)) return false
    return true
  })
})

const totals = computed(() => {
  let given = 0
  let received = 0
  for (const g of visible.value) {
    if (g.kind === 'give') given += g.amount_cents
    else received += g.amount_cents
  }
  return { given, received, net: received - given }
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

const contactRows = computed(() => contacts.value.filter((c) => !c.archived))

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function dayLabel(d: string) {
  const p = d.split('-').map(Number)
  const w = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()
  return `${p[1]}月${p[2]}日 ${WEEK[w]}`
}

function onMonthChange(m: string) {
  month.value = m
}

async function load() {
  err.value = ''
  try {
    const [g, c] = await Promise.all([
      api<{ items: Gift[] }>('/api/v1/gifts'),
      api<{ items: Contact[] }>('/api/v1/contacts'),
    ])
    gifts.value = g.items
    contacts.value = c.items
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
    <div class="summary three">
      <div class="card"><div class="k">送出</div><div class="v expense">{{ formatYuan(totals.given) }}</div></div>
      <div class="card"><div class="k">收到</div><div class="v income">{{ formatYuan(totals.received) }}</div></div>
      <div class="card"><div class="k">差额</div><div class="v" :class="totals.net >= 0 ? 'income' : 'expense'">
        {{ totals.net >= 0 ? '+' : '-' }}{{ formatYuan(Math.abs(totals.net)) }}
      </div></div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'gifts' }" @click="tab = 'gifts'">往来记录</button>
      <button :class="{ on: tab === 'contacts' }" @click="tab = 'contacts'">联系人</button>
    </div>

    <template v-if="tab === 'gifts'">
      <MonthNav :month="month" @change="onMonthChange" />
      <div class="card" style="margin-bottom: 12px; padding: 10px 12px">
        <input v-model="q" placeholder="搜索姓名 / 事由 / 备注" class="bare" />
      </div>
      <p v-if="err" class="err">{{ err }}</p>
      <div v-if="!visible.length" class="card muted">这个月还没有往来。点下面的「+」记一笔。</div>
      <div v-for="[day, rows] in grouped" :key="day" class="card" style="margin-bottom: 12px">
        <div class="day-h"><span>{{ dayLabel(day) }}</span></div>
        <div class="row" v-for="g in rows" :key="g.id" @click="router.push(`/favors/gift/${g.id}`)">
          <div>
            <div>{{ g.contact_name }}<template v-if="g.occasion"> · {{ g.occasion }}</template></div>
            <div class="muted">{{ g.kind === 'give' ? '送出' : '收到' }}<template v-if="g.note"> · {{ g.note }}</template></div>
          </div>
          <div class="amount" :class="g.kind === 'give' ? 'expense' : 'income'">
            {{ g.kind === 'give' ? '-' : '+' }}{{ formatYuan(g.amount_cents) }}
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <p v-if="err" class="err">{{ err }}</p>
      <div v-if="!contactRows.length" class="card muted">还没有联系人，点下面新增</div>
      <div v-else class="card">
        <div class="row" v-for="c in contactRows" :key="c.id" @click="router.push(`/favors/person/${c.id}`)">
          <span class="avatar">{{ c.name.slice(0, 1) }}</span>
          <div>
            <div>{{ c.name }}<template v-if="c.relation"> · {{ c.relation }}</template></div>
            <div class="muted">送出 {{ formatYuan(c.given_cents) }} · 收入 {{ formatYuan(c.received_cents) }}</div>
          </div>
          <div class="amount" :class="c.net_cents >= 0 ? 'income' : 'expense'">
            {{ c.net_cents >= 0 ? '+' : '' }}{{ formatYuan(c.net_cents) }}
          </div>
        </div>
      </div>
      <button class="btn ghost" type="button" @click="router.push('/favors/people')">新增联系人</button>
    </template>
  </div>
</template>
